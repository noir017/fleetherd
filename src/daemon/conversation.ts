import path from 'node:path';
import { configDir } from '../config/load.js';
import type { AgentDef, Config } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import { harnessCommandName } from '../core/command-translate.js';
import { agentCatalog, agentGroups, agentPlaceOf } from '../core/agent-menu.js';
import {
  addressOf,
  conversationKey,
  describeConversation,
  formatAddress,
  type ConversationAddress,
  type ConversationRef,
} from '../core/conversation.js';
import type { EffortChoiceResult } from '../core/effort-menu.js';
import type { Locale } from '../core/i18n/index.js';
import { shouldRespond, type GateConfig } from '../core/inbound-gate.js';
import type { SoloOutcome } from '../core/inbound-merger.js';
import type { ModelChoiceResult } from '../core/model-menu.js';
import type { SettingApplyResult, SettingOption, SettingRow } from '../core/settings.js';
import { parseTextCommand } from '../core/text-command.js';
import { buildWorkdirScreen, workdirBaseName, type WorkdirChoiceResult } from '../core/workdir-menu.js';
import type { WorkdirScan } from './workdir-scan.js';
import type { HistoryStore } from '../history/store.js';
import type { ListChannelsResult } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type {
  ConversationWorkdir,
  ModelPickerList,
  ModelPickerResult,
  SessionOptionList,
  SessionOptionPeek,
  SessionOptionResult,
  TopicSetupResult,
  TurnChangeFileResult,
  TurnChangeStatusResult,
  WorkdirBrowseResult,
} from '../platform/workbench.js';
import type { AgentCatalog, AgentHandoffAction, AgentStatus, ConversationId, InboundMessage, TopicActivity } from '../types.js';
import type { AgentFactory } from './agent.js';
import { resolveAgentCwd, resolveConversationCwd } from './agent-common.js';
import { isDirectory } from './workdir-scan.js';
import { runAgyCliCommand } from './agy-cli.js';
import type { RespawnCounts } from './config-reload.js';
import { ConversationCommands } from './conversation-commands.js';
import type {
  ConversationClock,
  ConversationContext,
  ConversationHooks,
  ConversationLane,
  ConversationState,
  SwitchRefusal,
} from './conversation-context.js';
import { ConversationControls } from './conversation-controls.js';
import {
  type AgentLists,
  ConversationDelegation,
  type OpenTaskOptions,
  type ScheduledConversationOptions,
  type TaskChoice,
} from './conversation-delegation.js';
import { ConversationHistory } from './conversation-history.js';
import type { ConversationStore } from './conversation-store.js';
import { SessionTokenRegistry } from './conversation-token-registry.js';
import { ConversationTurns, type KillOutcome, type StopOutcome, type StopResult } from './conversation-turns.js';
import { ModelCatalog } from './model-catalog.js';
import type { ReviewFacts } from './review.js';
import { resolveAgent, resolveScope, routeInputFromMessage, routeInputFromRef, type AgentChoice } from './routing.js';
import { StatusBoard } from './status-board.js';
import { TurnChanges } from './turn-changes.js';
import type { KeptText } from './turn-outcomes.js';
import { TurnProgressBoard, type LiveTurn } from './turn-progress.js';
import type { WorkdirUsageStore } from './workdir-usage.js';
import { workspaceFor, type Workspace } from './workspace.js';

/**
 * A refused agent switch: a handover note carrying what the NEXT agent needs to find this
 * conversation on disk (session id, directory), in code spans so a tap copies them whole.
 */
export function agentSwitchRefusalText(p: {
  bound: string;
  wanted: string;
  wantedCommand: string;
  sessionId: string;
  workdir?: string;
}): string {
  return [
    `This topic stays with ${p.bound} — a topic does not switch agents once it has a session.`,
    `• ${p.bound} session id: \`${p.sessionId}\``,
    ...(p.workdir ? [`• Working directory: \`${p.workdir}\``] : []),
    `To continue with ${p.wanted}, open a new topic, start it with \`${p.wantedCommand}\` and give it that session id — it can find the earlier conversation itself. (\`/new\` here clears this topic, and then any agent can take it.)`,
  ].join('\n');
}

/**
 * Conversation registry: the per-conversation state table, routing, agent binding, and the facade
 * the daemon calls. The work is done by collaborators sharing one ConversationContext: turns
 * (merger, runner, stop/kill, drain, reclaim, retry), controls (`/model` `/effort` `/cd` `/fork`
 * `/title`), commands (slash-command interception and translation), history and delegation.
 *
 * A conversation lives until shutdown or `/new`; its agent child does not (idle reclaim).
 */
export class ConversationRegistry {
  private conversations = new Map<ConversationId, ConversationState>();
  /** Auto-created thread → the conversation that opened it (in memory only: a restart degrades gracefully). */
  private threadAliases = new Map<ConversationId, ConversationId>();
  private tokens = new SessionTokenRegistry();
  private readonly turnChanges: TurnChanges;
  private readonly status: StatusBoard;
  private readonly modelCatalog: ModelCatalog;
  private readonly progress: TurnProgressBoard;
  private readonly gateConfigs = new Map<string, GateConfig>();
  private readonly recorder: ConversationHistory;
  private readonly controls: ConversationControls;
  private readonly turns: ConversationTurns;
  private readonly commands: ConversationCommands;
  private readonly delegation: ConversationDelegation;

  constructor(
    private readonly config: Config,
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly agents: AgentFactory,
    private readonly clock: ConversationClock,
    private readonly hooks?: ConversationHooks,
    private readonly store?: ConversationStore,
    /** Absent is supported: the `/cd` list then stays in the scan's alphabetical order. */
    private readonly workdirUsage?: WorkdirUsageStore,
    /** Injected so a test can pin that a CLI-answered name never reaches the agent, without spawning one. */
    private readonly runHarnessCli: typeof runAgyCliCommand = runAgyCliCommand,
    /** The conversation library; absent is supported (every write is best-effort). */
    private readonly history?: HistoryStore
  ) {
    this.progress = new TurnProgressBoard(this.clock);
    this.modelCatalog = this.makeModelCatalog();
    this.turnChanges = new TurnChanges({ dir: configDir(), clock: this.clock, workspaceFor: (ref) => this.workspaceForRef(ref) });
    this.status = new StatusBoard({
      laneOf: (id) => this.laneOf(id),
      platforms: this.platforms,
      agentOf: (id) => this.agentIdOf(id),
      configuredModel: (id) =>
        this.conversations.get(id)?.modelOverride ?? findAgent(this.config, this.agentIdOf(id))?.model,
      permissionsOf: (id) => this.controls?.permissionsForAgent(this.agentIdOf(id)),
      cacheReading: (id) => this.recorder.cacheReading(id),
      clock: this.clock,
    });
    const ctx = this.makeContext();
    this.recorder = new ConversationHistory(ctx);
    this.controls = new ConversationControls(ctx, this.recorder);
    this.turns = new ConversationTurns(ctx, this.controls, this.recorder);
    this.commands = new ConversationCommands(ctx, this.turns, this.controls);
    this.delegation = new ConversationDelegation(ctx, this.turns, this.controls);
    this.turns.startIdleSweeper();
  }

  private makeContext(): ConversationContext {
    return {
      config: this.config,
      platforms: this.platforms,
      agents: this.agents,
      clock: this.clock,
      hooks: this.hooks,
      store: this.store,
      history: this.history,
      workdirUsage: this.workdirUsage,
      runHarnessCli: this.runHarnessCli,
      conversations: this.conversations,
      tokens: this.tokens,
      status: this.status,
      progress: this.progress,
      modelCatalog: this.modelCatalog,
      turnChanges: this.turnChanges,
      laneOf: (id) => this.laneOf(id),
      laneFor: (id) => this.laneFor(id),
      agentIdOf: (id) => this.agentIdOf(id),
      boundAgentOf: (id) => this.boundAgentOf(id),
      boundAgentFor: (id, fallback) => this.boundAgentFor(id, fallback),
      workdirOf: (id, agentId) => this.workdirOf(id, agentId),
      idForRef: (ref) => this.idForRef(ref),
      conversationAt: (platform, address) => this.conversationAt(platform, address),
      ensureState: (key, platform, agentId, opts) => this.ensureState(key, platform, agentId, opts),
      releaseState: (id) => this.releaseState(id),
      touch: (id) => this.touch(id),
      forgetUsage: (id, state) => this.forgetUsage(id, state),
      isBusy: (key) => this.isBusy(key),
      adoptThread: (id, address, platformId) => this.adoptThread(id, address, platformId),
      switchRefusal: (key, agentId, wantedCommand, conv) => this.switchRefusal(key, agentId, wantedCommand, conv),
      rebind: (key, state, agentId, platformId, address, announce) =>
        this.rebind(key, state, agentId, platformId, address, announce),
      chooseAgent: (key, agentId, conv) => this.chooseAgent(key, agentId, conv),
      resetConversation: (id) => this.resetConversation(id),
    };
  }

  private makeModelCatalog(): ModelCatalog {
    const live = <T>(agentId: string, read: (id: ConversationId) => T | undefined): T | undefined => {
      for (const [id, state] of this.conversations) {
        if (state.agentId !== agentId) continue;
        const found = read(id);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return new ModelCatalog({
      agents: this.agents,
      defOf: (agentId) => findAgent(this.config, agentId),
      liveSelector: (agentId) =>
        live(agentId, (id) => {
          const selector = this.agents.peek(id)?.modelSelector?.();
          return selector && selector.options.length > 0 ? selector : undefined;
        }),
      liveModes: (agentId) =>
        live(agentId, (id) => {
          const modes = this.agents.peek(id)?.permissionModes?.();
          return modes && modes.options.length > 0 ? modes : undefined;
        }),
      liveOptions: (agentId) => live(agentId, (id) => this.agents.peek(id)?.sessionOptions?.()),
      liveCanFork: (agentId) => live(agentId, (id) => this.agents.peek(id)?.canFork?.()),
      liveEffort: (agentId) => live(agentId, (id) => this.agents.peek(id)?.effortSelector?.()),
      tokenFor: (sid) => this.tokens.tokenFor(sid as ConversationId),
      forget: (sid) => {
        this.store?.clear(sid);
        this.tokens.release(sid as ConversationId);
      },
    });
  }

  // ───────────────────────────── routing ─────────────────────────────

  /**
   * Inbound entry (daemon wires platform.onMessage here). `transcript`: a confirmed voice transcript
   * re-entering — not offered for transcription again, and not superseding the other transcripts.
   */
  route(msg: InboundMessage, opts?: { transcript?: boolean }): void {
    const conv = msg.conversation;
    const address = addressOf(conv);
    if (!this.isAllowed(msg)) {
      console.log(`[access] denied identity ${conv.platform}:${conv.user} ${describeConversation(conv)}`);
      return;
    }

    // The key is agent-free: which agent answers is a property OF the conversation.
    const input = routeInputFromMessage(msg);
    const rawKey = conversationKey(resolveScope(this.config, input), conv);
    const key = this.threadAliases.get(rawKey) ?? rawKey;
    const choice = resolveAgent(this.config, input);
    const stripped = stripAgentPrefix(choice, msg);
    msg = stripped.msg;
    if (!this.passesGate(key, msg, stripped.bare)) return;

    // Past every gate: the conversation is alive, and a person is driving it (a pending continue is called off).
    this.touch(key);
    this.turns.outcomes.personActed(key);

    if (this.commands.intercept(key, msg, address, choice)) return;

    const state = this.stateFor(key, choice, conv, address);
    // A bare `/oc` is a binding instruction, not a prompt.
    if (stripped.bare !== undefined) {
      this.commands.answerBare(key, state, conv.platform, address, msg);
      return;
    }
    // Before voice, so a message about to be refused spends no transcription.
    if (this.turns.refuseWhileDraining(key, state, address, msg)) return;
    if (this.turns.takesVoice(key, msg, opts)) return;

    // Translation needs the bound agent, and is the last point a message can still be refused.
    const forward = (m: InboundMessage): void => this.turns.forward(key, state, m, opts);
    const forwarded = this.commands.translate(key, state, msg, forward);
    if (!forwarded) return;
    forward(forwarded);
  }

  /**
   * The response gate, on the ORIGINAL content: a bare `/oc` strips to empty and must not trip the
   * empty-message gate. `hasActiveSession` is read before any merger exists, or it is always true.
   */
  private passesGate(key: ConversationId, msg: InboundMessage, bare: string | undefined): boolean {
    const conv = msg.conversation;
    const gateMsg = bare !== undefined ? { ...msg, content: `/${bare}` } : msg;
    const decision = shouldRespond(gateMsg, this.gateFor(conv.platform), { hasActiveSession: this.conversations.has(key) });
    if (decision.respond) return true;
    console.log(`[gate] ignoring message (${decision.reason}) ${describeConversation(conv)}`);
    return false;
  }

  /**
   * This conversation's state, bound on first sight — an explicit `/oc` outranks the binding a
   * previous run stored (else the first message after a restart ignores its own prefix), which
   * outranks routing. An existing one moves only on an explicit `/name` or a removed agent.
   */
  private stateFor(key: ConversationId, choice: AgentChoice, conv: ConversationRef, address: ConversationAddress): ConversationState {
    const existing = this.conversations.get(key);
    if (!existing) {
      const agentId = choice.explicit ? choice.agentId : (this.storedBinding(key) ?? choice.agentId);
      return this.createState(key, agentId, conv.platform, '');
    }
    existing.platform = conv.platform; // shared-scope conversations may hop platform instances
    if (this.mustRebind(key, existing, choice)) this.rebind(key, existing, choice.agentId, conv.platform, address);
    return existing;
  }

  /** Gating rules for one platform instance; an unknown instance gets the safe default (mention required). */
  private gateFor(platformId: string): GateConfig {
    let gate = this.gateConfigs.get(platformId);
    if (!gate) {
      const chat = this.config.platforms[platformId]?.chat;
      gate = {
        requireMentionInGuild: chat?.requireMention ?? true,
        freeResponseChannels: chat?.freeResponseChannels ?? [],
        ignoredChannels: chat?.ignoredChannels ?? [],
        allowBots: chat?.allowBots ?? 'none',
        respondInDirect: this.config.inbound.gating.respondInDirect,
        threadParticipationExempt: this.config.inbound.gating.threadParticipationExempt,
      };
      this.gateConfigs.set(platformId, gate);
    }
    return gate;
  }

  /** allowFrom access gate: empty = unrestricted; non-empty allows only allowlisted identities. */
  private isAllowed(msg: InboundMessage): boolean {
    const allow = this.config.access.allowFrom;
    if (allow.length === 0) return true;
    return allow.includes(`${msg.conversation.platform}:${msg.conversation.user}`);
  }

  /** Called by TurnRunner when autoThread moved a turn into a new thread: a reply there continues here. */
  private adoptThread(
    id: ConversationId,
    address: ConversationAddress,
    platformId: string
  ): void {
    if (!this.conversations.has(id)) return;
    const ref = {
      platform: platformId,
      channel: address.channel,
      ...(address.thread != null ? { thread: address.thread } : {}),
      kind: 'thread' as const,
      user: '',
    };
    // Only location-dependent scopes: per_user/shared keys already resolve the thread here.
    const scope = resolveScope(this.config, ref);
    if (scope !== 'per_thread' && scope !== 'per_channel') return;
    const threadKey = conversationKey(scope, ref);
    if (threadKey === id) return;
    this.threadAliases.set(threadKey, id);
    console.log(`[conversation] auto-thread ${formatAddress(address)} adopted by ${id}`);
  }

  // ───────────────────────────── agent binding ─────────────────────────────

  /** A stored binding to an agent since removed counts as none: nothing is left to resume. */
  private storedBinding(key: ConversationId): string | undefined {
    const stored = this.store?.boundAgent(key);
    return stored !== undefined && findAgent(this.config, stored) ? stored : undefined;
  }

  private mustRebind(key: ConversationId, state: ConversationState, choice: AgentChoice): boolean {
    if (choice.explicit && choice.agentId !== state.agentId) return true;
    if (findAgent(this.config, state.agentId)) return false;
    console.log(`[reload] ${key}: agent "${state.agentId}" is no longer configured; rebinding to "${choice.agentId}"`);
    return true;
  }

  /**
   * Why a switch to `agentId` is refused: the bound agent has a session id on record (read from the
   * store, so the first message after a restart is held to it). Before that, naming an agent chooses one.
   */
  private switchRefusal(
    key: ConversationId,
    agentId: string,
    wantedCommand?: string,
    conv?: ConversationRef
  ): SwitchRefusal | undefined {
    const bound = this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key);
    if (!bound || bound === agentId) return undefined;
    const boundDef = findAgent(this.config, bound);
    if (!boundDef) return undefined;
    const sessionId = this.store?.agentSession(key, bound);
    if (sessionId === undefined) return undefined;
    console.log(`[conversation] ${key} is bound to "${bound}" with a session; refused a switch to "${agentId}"`);
    const wantedDef = findAgent(this.config, agentId);
    const boundName = agentDisplayName(boundDef, bound);
    const wantedName = agentDisplayName(wantedDef, agentId);
    const workdir = this.workdirOf(key, bound);
    const text = agentSwitchRefusalText({
      bound: boundName,
      wanted: wantedName,
      wantedCommand: wantedCommand ?? `/${harnessCommandName(wantedDef?.harness) ?? agentId}`,
      sessionId,
      workdir,
    });
    const handoff = this.buildSwitchHandoff({
      key,
      conv,
      agentId,
      wantedDef,
      wantedName,
      boundDef,
      boundName,
      sessionId,
      workdir,
    });
    return handoff ? { text, handoff } : { text };
  }

  private buildSwitchHandoff(p: {
    key: ConversationId;
    conv?: ConversationRef;
    agentId: string;
    wantedDef?: AgentDef;
    wantedName: string;
    boundDef: AgentDef;
    boundName: string;
    sessionId: string;
    workdir?: string;
  }): AgentHandoffAction | undefined {
    const platformId = p.conv?.platform ?? this.conversations.get(p.key)?.platform;
    const adapter = platformId ? this.platforms.get(platformId) : undefined;
    if (adapter?.capabilities.handoffAction !== true) return undefined;
    const fromTopicId = p.conv?.thread ?? this.laneOf(p.key)?.address.thread;
    const fromTopicTitle = this.store?.conversationTitle(p.key);
    return {
      agentId: p.agentId,
      agentName: p.wantedName,
      fromAgent: p.boundName,
      sessionId: p.sessionId,
      ...(p.workdir ? { workdir: p.workdir } : {}),
      sameHost: (p.boundDef.host ?? '') === (p.wantedDef?.host ?? ''),
      ...(fromTopicId ? { fromTopicId } : {}),
      ...(fromTopicTitle ? { fromTopicTitle } : {}),
    };
  }

  /**
   * Move a conversation to another agent (only while it has no session to lose): the outgoing child
   * is disposed so it cannot keep streaming here; model override and usage belonged to the old agent.
   */
  private rebind(
    key: ConversationId,
    state: ConversationState,
    agentId: string,
    platformId: string,
    address: ConversationAddress,
    announce = true
  ): string {
    const previous = state.agentId;
    this.agents.dispose(key);
    state.agentId = agentId;
    state.headerSent = false;
    state.modelOverride = undefined;
    this.forgetUsage(key, state);
    this.store?.bind(key, agentId);
    const name = agentDisplayName(findAgent(this.config, agentId), agentId);
    const resuming = this.store?.agentSession(key, agentId) != null;
    console.log(
      `[conversation] ${key} rebound ${previous} → ${agentId}${resuming ? ' (resuming its existing session)' : ''}`
    );
    const text = resuming ? `▸ back to ${name} — resuming where you left off` : `▸ ${name} is answering this conversation now`;
    if (announce) {
      void this.platforms
        .get(platformId)
        ?.sendMessage(address, text)
        .catch((e) => console.warn('[conversation] failed to ack the rebind:', e instanceof Error ? e.message : e));
    }
    return text;
  }

  /** `/agent <id>`, typed or picked: bind by id, under the same switch lock as `/cc`. Returns what to say. */
  chooseAgent(key: ConversationId, agentId: string, conv: ConversationRef): SwitchRefusal {
    const def = findAgent(this.config, agentId);
    if (!def) return { text: `No agent "${agentId}" is configured.` };
    const refused = this.switchRefusal(key, agentId, `/agent ${agentId}`, conv);
    if (refused !== undefined) return refused;
    const name = agentDisplayName(def, agentId);
    const state = this.conversations.get(key);
    if (state?.agentId === agentId) return { text: `${name} is already answering this topic.` };
    if (state) return { text: this.rebind(key, state, agentId, conv.platform, addressOf(conv), false) };
    this.createState(key, agentId, conv.platform, ' (chosen with /agent)');
    return { text: `▸ ${name} is answering this conversation now` };
  }

  offerPlacement(key: ConversationId, agentId: string, conv: ConversationRef): void {
    this.controls.offerPlacement(key, agentId, conv);
  }

  // ───────────────────────────── state and lookups ─────────────────────────────

  /** This conversation's state, created if absent; `fresh` binds the given agent whatever the store remembers. */
  private ensureState(
    key: ConversationId,
    platform: string,
    agentId: string,
    opts: { fresh?: boolean; opener?: string } = {}
  ): ConversationState {
    const state = this.conversations.get(key);
    if (state) return state;
    const bound = opts.fresh ? agentId : (this.store?.boundAgent(key) ?? agentId);
    return this.createState(key, bound, platform, ` (${opts.opener ?? 'scheduled run'})`);
  }

  private createState(key: ConversationId, agentId: string, platform: string, note: string): ConversationState {
    const state: ConversationState = {
      merger: this.turns.buildMerger(key),
      agentId,
      platform,
      lastActivityAt: this.clock.now(),
      ...this.restoredModel(key, agentId),
    };
    this.conversations.set(key, state);
    this.store?.bind(key, agentId);
    console.log(`[conversation] ${key} bound to agent "${agentId}"${note}`);
    return state;
  }

  /** The person's recorded model choice, so the status line and `/model` name it after a restart. */
  private restoredModel(key: ConversationId, agentId: string): Pick<ConversationState, 'modelOverride'> {
    const model = this.store?.conversationChoice?.(key, agentId, 'model');
    return model === undefined ? {} : { modelOverride: model };
  }

  /** Anything that means "work is happening here": a message, a turn's end, a reverse command. */
  touch(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (state) state.lastActivityAt = this.clock.now();
  }

  /** The lane this conversation writes to between turns; undefined only before its first turn. */
  private laneOf(id: ConversationId): ConversationLane | undefined {
    const state = this.conversations.get(id);
    if (!state?.lane) return undefined;
    return { address: state.lane, platformId: state.lanePlatform ?? state.platform };
  }

  /** The lane, falling back to what the store recorded (no in-memory lane before a restart's first turn). */
  laneFor(key: ConversationId): ConversationLane | undefined {
    const live = this.laneOf(key);
    if (live) return live;
    const rec = this.store?.entries?.().find(([k]) => k === key)?.[1].lane;
    if (!rec) return undefined;
    return {
      platformId: rec.platform,
      address: rec.thread ? { channel: rec.channel, thread: rec.thread } : { channel: rec.channel },
    };
  }

  /**
   * The instance owning a conversation's OUTBOUND (the lane's), for reverse commands: pairing the
   * lane's address with another instance's adapter would send one platform's channel id to another.
   */
  platformFor(id: ConversationId): string | undefined {
    const state = this.conversations.get(id);
    return state?.lanePlatform ?? state?.platform;
  }

  private agentIdOf(id: ConversationId): string {
    return this.conversations.get(id)?.agentId ?? this.config.routing.default;
  }

  boundAgentOf(key: ConversationId): string | undefined {
    return this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key);
  }

  /** For a command that may arrive before any state: the stored binding beats routing.default after a restart. */
  private boundAgentFor(id: ConversationId, fallback: string): string {
    return this.conversations.get(id)?.agentId ?? this.store?.boundAgent(id) ?? fallback;
  }

  /** The directory the next turn runs in — the runtimes' own resolveConversationCwd, so nothing disagrees. */
  workdirOf(id: ConversationId, agentId?: string): string | undefined {
    const def = findAgent(this.config, agentId ?? this.agentIdOf(id));
    return def ? resolveConversationCwd(def, id, this.store) : undefined;
  }

  /** An address's conversation through scope and aliases: building the key is not a platform's business. */
  private idForRef(ref: ConversationRef): ConversationId {
    const scope = resolveScope(this.config, {
      platform: ref.platform,
      channel: ref.channel,
      ...(ref.thread != null ? { thread: ref.thread } : {}),
      ...(ref.space != null ? { space: ref.space } : {}),
      user: ref.user,
      kind: ref.kind,
      isBot: false,
    });
    const raw = conversationKey(scope, ref);
    return this.threadAliases.get(raw) ?? raw;
  }

  /**
   * The conversation at an address and its agent. Undefined under `per_user` (an address names no
   * single conversation). Built as `direct`: a timer has no sender and wants no speaker prefix or thread.
   */
  conversationAt(platform: string, address: ConversationAddress): { key: ConversationId; agent?: string } | undefined {
    const ref: ConversationRef = {
      platform,
      channel: address.channel,
      ...(address.thread ? { thread: address.thread } : {}),
      kind: 'direct',
      user: '',
    };
    if (resolveScope(this.config, { ...ref, isBot: false }) === 'per_user') return undefined;
    const key = this.idForRef(ref);
    const agent = this.conversations.get(key)?.agentId ?? this.store?.boundAgent(key);
    return agent !== undefined ? { key, agent } : { key };
  }

  conversationTitle(key: ConversationId): string | undefined {
    return this.store?.conversationTitle(key);
  }

  isBusy(key: ConversationId): boolean {
    const state = this.conversations.get(key);
    return state !== undefined && !state.merger.isIdle();
  }

  isAsking(key: ConversationId): boolean {
    return this.hooks?.hasPendingWork?.(key) ?? false;
  }

  progressOf(id: ConversationId): LiveTurn | undefined {
    return this.progress.progressOf(id);
  }

  runningSince(id: ConversationId): number | undefined {
    return this.conversations.get(id)?.merger.runningSince();
  }

  statusOf(id: ConversationId): AgentStatus | undefined {
    return this.status.statusOf(id);
  }

  setModelOverride(id: ConversationId, model: string): void {
    const state = this.conversations.get(id);
    if (state) state.modelOverride = model;
  }

  clearModelOverride(id: ConversationId): void {
    const state = this.conversations.get(id);
    if (state) state.modelOverride = undefined;
  }

  /** Drop the context snapshot and the status strip together: both describe the context just discarded. */
  private forgetUsage(id: ConversationId, state: ConversationState): void {
    state.lastUsage = undefined;
    state.lastCost = undefined;
    state.turnStarted = false;
    state.turnCompleted = false;
    this.status.reset(id);
  }

  // ───────────────────────────── reverse commands ─────────────────────────────

  /**
   * Validate a reverse-command token and return the lane it writes to. ⚠️ Security boundary: the
   * token is conversation-scoped (no expiry) and an override (`--channel`) has no channel-level
   * authorization, by design (cross-channel reports); the mitigation is `access.allowFrom`.
   */
  resolveAddress(token: string, override?: ConversationAddress): ConversationAddress {
    const id = this.tokens.conversationFor(token);
    if (!id) throw new Error('invalid session token');
    if (override) return override;
    const lane = this.laneOf(id);
    if (!lane) {
      throw new Error('this conversation has not run a turn yet; cannot locate a channel');
    }
    return lane.address;
  }

  conversationForToken(token: string): ConversationId | undefined {
    return this.tokens.conversationFor(token);
  }

  listChannels(opts: { platform?: string; query?: string; limit: number; currentKey?: ConversationId }): ListChannelsResult {
    return this.recorder.listChannels(opts);
  }

  // ───────────────────────────── platform lookups by address ─────────────────────────────

  /** Where the conversation at an address works; the agent is named only when one is bound. */
  workdirForRef(ref: ConversationRef): ConversationWorkdir | undefined {
    const id = this.idForRef(ref);
    const bound = this.boundAgentFor(id, '');
    const def = findAgent(this.config, bound || this.config.routing.default);
    if (!def) return undefined;
    const host = agentPlaceOf(def);
    const canFork = bound ? this.modelCatalog.canFork(def.id) : undefined;
    return {
      path: resolveConversationCwd(def, id, this.store),
      ...(host ? { host } : {}),
      ...(bound ? { agent: { id: def.id, harness: def.harness, ...(canFork !== undefined ? { canFork } : {}) } } : {}),
    };
  }

  /** Which agents a new topic could still be given; closed once its agent has a session, or with one agent. */
  agentCatalogForRef(ref: ConversationRef): AgentCatalog | undefined {
    if (this.config.agents.length < 2) return undefined;
    const id = this.idForRef(ref);
    const bound = this.boundAgentFor(id, '');
    const current = bound || resolveAgent(this.config, routeInputFromRef(ref)).agentId;
    if (this.store?.agentSession(id, current) !== undefined) return undefined;
    return agentCatalog(agentGroups(this.config.agents), current, {
      agentChosen: Boolean(bound),
      cwdChosen: this.store?.conversationCwd(id) !== undefined,
    });
  }

  /** Bind a new/empty topic's agent and working directory in one step; never adds prompt text. */
  setupTopicForRef(ref: ConversationRef, opts: { agent?: string; cwd?: string; dryRun?: boolean }): TopicSetupResult {
    const id = this.idForRef(ref);
    const prevAgent = this.boundAgentFor(id, resolveAgent(this.config, routeInputFromRef(ref)).agentId);
    const targetAgent = opts.agent ?? prevAgent;
    const def = findAgent(this.config, targetAgent);
    if (!def) return { ok: false, error: `No agent "${targetAgent}" is configured.` };
    const validated = this.validateTopicSetup(id, targetAgent, Boolean(def.host), opts);
    if (!validated.ok) return validated;
    const crossHostClear = this.isCrossHostSwitch(prevAgent, def, opts);
    if (opts.dryRun) {
      const cwd = validated.cwd ?? (crossHostClear ? resolveAgentCwd(def) : resolveConversationCwd(def, id, this.store));
      return { ok: true, agent: targetAgent, cwd };
    }
    const prevState = this.conversations.get(id);
    const prevAgentId = prevState?.agentId;
    const prevStoreAgent = this.store?.boundAgent(id);
    if (opts.agent !== undefined) {
      if (prevState && prevState.agentId !== targetAgent) {
        this.rebind(id, prevState, targetAgent, ref.platform, addressOf(ref), false);
      } else if (!prevState) {
        this.createState(id, targetAgent, ref.platform, ' (chosen at topic setup)');
      }
    }
    const wdError = this.applyTopicWorkdir(id, targetAgent, def, validated.cwd, crossHostClear);
    if (wdError !== undefined) {
      if (opts.agent !== undefined) this.rollbackAgentBind(id, prevState, prevAgentId, prevStoreAgent);
      return { ok: false, error: wdError };
    }
    return { ok: true, agent: targetAgent, cwd: resolveConversationCwd(def, id, this.store) };
  }

  private isCrossHostSwitch(prevAgent: string, def: AgentDef, opts: { agent?: string; cwd?: string }): boolean {
    if (opts.agent === undefined || opts.cwd !== undefined) return false;
    const prevDef = findAgent(this.config, prevAgent);
    return Boolean(prevDef && (prevDef.host ?? '') !== (def.host ?? ''));
  }

  private applyTopicWorkdir(
    id: ConversationId,
    targetAgent: string,
    def: AgentDef,
    cwd: string | undefined,
    crossHostClear: boolean
  ): string | undefined {
    if (cwd !== undefined) {
      const wdRes = this.controls.setWorkdir(id, targetAgent, cwd);
      if (wdRes.kind === 'failed' || wdRes.kind === 'missing') {
        return wdRes.kind === 'failed' ? wdRes.reason : `Directory does not exist: ${wdRes.path}`;
      }
      return undefined;
    } else if (crossHostClear && this.store?.conversationCwd(id) !== undefined) {
      const wdRes = this.controls.setWorkdir(id, targetAgent, resolveAgentCwd(def));
      if (wdRes.kind === 'unchanged' || wdRes.kind === 'missing') {
        this.store.setConversationCwd(id, targetAgent, undefined);
      }
    }
    return undefined;
  }

  /** Browse one level of directories for a topic's selected agent, using `/cd`'s screen format. */
  async browseWorkdirForRef(
    ref: ConversationRef,
    opts?: { agent?: string; dir?: string; atRoot?: boolean; cachedOnly?: boolean }
  ): Promise<WorkdirBrowseResult> {
    const id = this.idForRef(ref);
    const agentId =
      opts?.agent ?? this.boundAgentFor(id, resolveAgent(this.config, routeInputFromRef(ref)).agentId);
    const def = findAgent(this.config, agentId);
    if (!def) return { ok: false, error: `No agent "${agentId}" is configured.` };
    const root = resolveAgentCwd(def);
    const current = resolveConversationCwd(def, id, this.store);
    const posixPaths = Boolean(def.host);
    const resolved = this.resolveBrowseDir(opts?.dir, opts?.atRoot ? root : current, posixPaths);
    if (!resolved.ok) return resolved;
    const targetDir = resolved.dir;
    const scan = await this.controls.scanWorkdirAt(
      agentId,
      targetDir,
      opts?.cachedOnly ? { cachedOnly: true } : undefined
    );
    if (opts?.cachedOnly && !scan.ok) return { ok: false, error: scan.reason };
    const screen = buildWorkdirScreen({
      reqId: 'launch',
      agentId,
      ...(def.host ? { host: def.host } : {}),
      root,
      current,
      browsing: targetDir,
      options: scan.ok
        ? scan.options
        : [{ path: targetDir, name: workdirBaseName(targetDir, posixPaths), root: targetDir === root }],
      truncated: scan.ok ? scan.truncated : 0,
      posixPaths,
      ...(scan.ok ? {} : { error: scan.reason }),
    });
    return { ok: true, screen };
  }

  private resolveBrowseDir(
    raw: string | undefined,
    fallback: string,
    isRemote: boolean
  ): { ok: true; dir: string } | { ok: false; error: string } {
    if (raw === undefined) return { ok: true, dir: fallback };
    if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, error: 'Working directory contains invalid characters.' };
    if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(raw)) {
      return { ok: false, error: 'Working directory must be a normalized absolute path without "..".' };
    }
    if (isRemote) {
      if (!(raw.startsWith('/') || raw === '~' || raw.startsWith('~/'))) {
        return { ok: false, error: 'Working directory must be an absolute path.' };
      }
      return { ok: true, dir: raw };
    }
    if (!path.isAbsolute(raw)) return { ok: false, error: 'Working directory must be an absolute path.' };
    return { ok: true, dir: path.normalize(raw) };
  }

  private validateTopicSetup(
    id: ConversationId,
    targetAgent: string,
    isRemote: boolean,
    opts: { agent?: string; cwd?: string }
  ): { ok: true; cwd?: string } | { ok: false; error: string } {
    if (opts.agent !== undefined) {
      const refused = this.switchRefusal(id, targetAgent, `/agent ${targetAgent}`);
      if (refused !== undefined) return { ok: false, error: refused.text };
    }
    if (opts.cwd === undefined) return { ok: true };
    if (this.controls.isWorkdirLocked(id, targetAgent)) {
      return { ok: false, error: 'Working directory cannot be changed once the session has started.' };
    }
    const checked = this.validateTopicCwd(opts.cwd, isRemote);
    if (!checked.ok) return checked;
    if (!this.store) {
      return { ok: false, error: 'this deployment keeps no conversation store, so a directory cannot be remembered' };
    }
    return { ok: true, cwd: checked.cwd };
  }

  private rollbackAgentBind(
    id: ConversationId,
    prevState: ConversationState | undefined,
    prevAgentId: string | undefined,
    prevStoreAgent: string | undefined
  ): void {
    if (!prevState) this.conversations.delete(id);
    else if (prevAgentId && prevState.agentId !== prevAgentId) prevState.agentId = prevAgentId;
    if (prevStoreAgent !== undefined) this.store?.bind(id, prevStoreAgent);
    else this.store?.clear(id);
  }

  private validateTopicCwd(raw: string, isRemote: boolean): { ok: true; cwd: string } | { ok: false; error: string } {
    if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, error: 'Working directory contains invalid characters.' };
    if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(raw)) {
      return { ok: false, error: 'Working directory must be a normalized absolute path without "..".' };
    }
    if (isRemote) {
      if (!(raw.startsWith('/') || raw === '~' || raw.startsWith('~/'))) {
        return { ok: false, error: 'Working directory must be an absolute path.' };
      }
      return { ok: true, cwd: raw };
    }
    if (!path.isAbsolute(raw)) {
      return { ok: false, error: 'Working directory must be an absolute path.' };
    }
    const normalized = path.normalize(raw);
    if (!isDirectory(normalized)) return { ok: false, error: `Directory does not exist: ${raw}` };
    return { ok: true, cwd: normalized };
  }

  /** Read off `reclaimState`, not `peek`: a handle outlives its reclaimed child. Absent reads as not live. */
  liveForRef(ref: ConversationRef): boolean {
    const session = this.agents.peek(this.idForRef(ref));
    return (session?.reclaimState?.() ?? 'no-child') !== 'no-child';
  }

  /**
   * The web UI's "Close idle agents": through reclaimSession, never killConversation — the page's
   * idle flags can be seconds old, and a topic that started working since must be skipped, not cut off.
   */
  reclaimIdleForRef(ref: ConversationRef): boolean {
    const id = this.idForRef(ref);
    const state = this.conversations.get(id);
    if (!state || !state.merger.isIdle()) return false;
    return this.turns.reclaimSession(id, 'closed as idle from the web UI');
  }

  /** For the review loop's commit reads (delegation.ts headOf); undefined with no agent bound. */
  workspaceOf(id: ConversationId): Workspace | undefined {
    const agent = this.boundAgentOf(id);
    const def = agent ? findAgent(this.config, agent) : undefined;
    return def ? workspaceFor(def, resolveConversationCwd(def, id, this.store)) : undefined;
  }

  /** Where an address's conversation keeps its files; nothing is started or recorded to answer. */
  workspaceForRef(ref: ConversationRef): Workspace | undefined {
    const id = this.idForRef(ref);
    const def = findAgent(this.config, this.boundAgentFor(id, resolveAgent(this.config, routeInputFromRef(ref)).agentId));
    return def ? workspaceFor(def, resolveConversationCwd(def, id, this.store)) : undefined;
  }

  turnChangesStatusForRef(ref: ConversationRef, turn: number): Promise<TurnChangeStatusResult> {
    return this.turnChanges.status(this.idForRef(ref), ref, turn);
  }

  turnChangesFileForRef(ref: ConversationRef, turn: number, path: string): Promise<TurnChangeFileResult> {
    return this.turnChanges.file(this.idForRef(ref), ref, turn, path);
  }

  turnChangesForgetForRef(ref: ConversationRef): void {
    this.turnChanges.forget(this.idForRef(ref), ref);
  }

  modelPickerForRef(ref: ConversationRef): Promise<ModelPickerList> {
    return this.controls.modelPickerForRef(ref);
  }

  chooseModelForRef(ref: ConversationRef, value: string): Promise<ModelPickerResult> {
    return this.controls.chooseModelForRef(ref, value);
  }

  optionStatusForRef(ref: ConversationRef): Promise<SessionOptionPeek> {
    return this.controls.optionStatusForRef(ref);
  }

  optionsForRef(ref: ConversationRef): Promise<SessionOptionList> {
    return this.controls.optionsForRef(ref);
  }

  chooseOptionForRef(ref: ConversationRef, optionId: string, value: string): Promise<SessionOptionResult> {
    return this.controls.chooseOptionForRef(ref, optionId, value);
  }

  // ───────────────────────────── menus the daemon posts ─────────────────────────────

  settingRows(locale?: Locale): SettingRow[] {
    return this.commands.settingRows(locale);
  }

  settingsBoundAgent(id: ConversationId): string {
    return this.commands.settingsBoundAgent(id);
  }

  settingOptionsFor(
    id: ConversationId,
    row: SettingRow,
    ask = true,
    locale?: Locale
  ): { options: SettingOption[]; hint?: string; asking?: Promise<unknown> } {
    return this.commands.settingOptionsFor(id, row, ask, locale);
  }

  modelListLoading(agentId: string): boolean {
    return this.commands.modelListLoading(agentId);
  }

  applySetting(id: ConversationId, row: SettingRow, raw: string): SettingApplyResult {
    return this.commands.applySetting(id, row, raw);
  }

  applyModelChoice(id: ConversationId, expectAgentId: string, value: string): Promise<ModelChoiceResult> {
    return this.controls.applyModelChoice(id, expectAgentId, value);
  }

  applyEffortChoice(id: ConversationId, expectAgentId: string, value: string): Promise<EffortChoiceResult> {
    return this.controls.applyEffortChoice(id, expectAgentId, value);
  }

  applyWorkdirChoice(id: ConversationId, expectAgentId: string, path: string): WorkdirChoiceResult {
    return this.controls.applyWorkdirChoice(id, expectAgentId, path);
  }

  scanWorkdirAt(agentId: string, dir: string, opts?: { readonly cachedOnly?: boolean }): Promise<WorkdirScan> {
    return this.controls.scanWorkdirAt(agentId, dir, opts);
  }

  workdirChoices(agentId: string): { root: string; dirs: string[] } | undefined {
    return this.controls.workdirChoices(agentId);
  }

  warmRemoteScans(): void {
    this.controls.warmRemoteScans();
  }

  // ───────────────────────────── turns ─────────────────────────────

  dispatchTo(id: ConversationId, msg: InboundMessage): boolean {
    return this.turns.dispatchTo(id, msg);
  }

  canSteer(id: ConversationId): boolean {
    return this.turns.runner.canSteer(id);
  }

  turnsInProgress(): number {
    return this.turns.turnsInProgress();
  }

  beginDrain(): void {
    this.turns.beginDrain();
  }

  stopWithPending(key: ConversationId, reason: string): StopResult & { calledOff: number; transcripts: number } {
    return this.turns.stopWithPending(key, reason);
  }

  stopConversation(id: ConversationId): StopOutcome {
    return this.turns.stopConversation(id);
  }

  interruptConversation(id: ConversationId): StopResult {
    return this.turns.interruptConversation(id);
  }

  recallPendingForRef(ref: ConversationRef, messageId?: string): { ok: boolean; recalled: number; content?: string } {
    const key = this.idForRef(ref);
    return this.turns.recallPending(key, messageId);
  }

  sendNowPendingForRef(ref: ConversationRef, messageId?: string, opts?: { interrupt?: boolean }): { ok: boolean; sent: number } {
    const key = this.idForRef(ref);
    return this.turns.sendNowPending(key, messageId, opts);
  }

  killConversation(id: ConversationId): KillOutcome {
    return this.turns.killConversation(id);
  }

  respawnAgents(agentIds: ReadonlySet<string>): RespawnCounts {
    return this.turns.respawnAgents(agentIds);
  }

  /** `session.idleTimeoutMs` was replaced by a config reload: the sweeper's timer has to follow. */
  idleTimeoutChanged(): void {
    this.turns.rearmIdleSweeper();
  }

  reclaimIdleSessions(): void {
    this.turns.reclaimIdleSessions();
  }

  reclaimAfterAskTimeout(id: ConversationId): void {
    this.turns.reclaimAfterAskTimeout(id);
  }

  reviewFacts(now = this.clock.now()): ReviewFacts[] {
    return this.turns.reviewFacts(now);
  }

  retryTurn(opts: { retryId: string; user: string; agentId?: string; reconnect?: boolean }): Promise<{ done: boolean; text: string }> {
    return this.turns.retryTurn(opts);
  }

  retryRecord(retryId: string): { conversation: ConversationId; agentId: string } | undefined {
    return this.turns.retryRecord(retryId);
  }

  recoverInterruptedTurns(): number {
    return this.turns.recoverInterruptedTurns();
  }

  coolingDown(agentId: string): boolean {
    return this.turns.outcomes.coolingDown(agentId);
  }

  activityOf(id: ConversationId): TopicActivity | undefined {
    return this.turns.outcomes.activityOf(id);
  }

  replyOf(id: ConversationId): KeptText | undefined {
    return this.turns.outcomes.replyOf(id);
  }

  failureOf(id: ConversationId): KeptText | undefined {
    return this.turns.outcomes.failureOf(id);
  }

  // ───────────────────────────── scheduled runs and sub-agents ─────────────────────────────

  runScheduledPrompt(opts: {
    key: ConversationId;
    platform: string;
    address: ConversationAddress;
    agentId: string;
    prompt: string;
    user?: string;
  }): Promise<SoloOutcome | { refused: string }> {
    return this.delegation.runScheduledPrompt(opts);
  }

  scheduledModelProblem(agentId: string, model: string, from: ConversationId | undefined): Promise<string | undefined> {
    return this.delegation.scheduledModelProblem(agentId, model, from);
  }

  scheduledChoicesProblem(agentId: string, choice: TaskChoice, from: ConversationId | undefined): Promise<string | undefined> {
    return this.delegation.scheduledChoicesProblem(agentId, choice, from);
  }

  agentLists(agentId: string): Promise<AgentLists> {
    return this.delegation.agentLists(agentId);
  }

  /** Turns in progress on `agentId` now, across every conversation. */
  runningOn(agentId: string): number {
    let n = 0;
    for (const state of this.conversations.values()) if (state.agentId === agentId && !state.merger.isIdle()) n++;
    return n;
  }

  applyScheduledModel(key: ConversationId, platform: string, agentId: string, model: string): Promise<string | undefined> {
    return this.delegation.applyScheduledModel(key, platform, agentId, model);
  }

  openScheduledConversation(opts: ScheduledConversationOptions): Promise<{
    key: ConversationId;
    address: ConversationAddress;
    ephemeral: boolean;
  }> {
    return this.delegation.openScheduledConversation(opts);
  }

  releaseScheduled(key: ConversationId): void {
    this.delegation.releaseScheduled(key);
  }

  openTask(opts: OpenTaskOptions): Promise<{ key: ConversationId; address: ConversationAddress; title: string }> {
    return this.delegation.openTask(opts);
  }

  handTo(
    key: ConversationId,
    platformId: string,
    address: ConversationAddress,
    text: string,
    header: string,
    opts: { queue?: boolean; forward?: { heading: string; text: string } } = {}
  ): Promise<'started' | 'joined' | 'queued'> {
    return this.delegation.handTo(key, platformId, address, text, header, opts);
  }

  // ───────────────────────────── reset and shutdown ─────────────────────────────

  /**
   * `/new`: dispose the child and forget EVERY agent's session id, so the next message starts fresh
   * even after a restart. The binding, directory and model/effort choices are kept (keepSetup).
   */
  resetConversation(id: ConversationId): void {
    // Not read off in-memory state alone: `/cd` and `/new` can arrive before a conversation has any.
    const agentId = this.conversations.get(id)?.agentId ?? this.store?.boundAgent(id);
    // Read before clear(): the generation must survive the reset it counts.
    const generation = (this.store?.conversationGeneration?.(id) ?? 0) + 1;
    const putSetupBack = this.keepSetup(id, agentId);
    this.agents.dispose(id);
    this.store?.clear(id);
    this.turns.forgetTurns(id);
    this.progress.forget(id);
    const state = this.conversations.get(id);
    if (state) {
      state.headerSent = false;
      this.forgetUsage(id, state);
    }
    if (agentId) {
      this.store?.bind(id, agentId);
      this.store?.setGeneration?.(id, agentId, generation);
      putSetupBack();
    }
  }

  /** How a conversation is set up (directory, model, effort), as opposed to what was said: survives `/new`. */
  private keepSetup(id: ConversationId, agentId: string | undefined): () => void {
    const store = this.store;
    if (!store || !agentId) return () => {};
    const cwd = store.conversationCwd(id);
    const model = store.conversationChoice?.(id, agentId, 'model');
    const effort = store.conversationChoice?.(id, agentId, 'effort');
    return () => {
      if (cwd) store.setConversationCwd(id, agentId, cwd);
      if (model) store.setConversationChoice?.(id, agentId, 'model', model);
      if (effort) store.setConversationChoice?.(id, agentId, 'effort', effort);
    };
  }

  /** Shutdown: stop the sweeper, release all mergers and agent sessions. */
  dispose(): void {
    this.turns.stopIdleSweeper();
    this.status.dispose();
    this.turns.outcomes.dispose();
    this.progress.dispose();
    for (const key of [...this.conversations.keys()]) {
      this.releaseState(key);
      this.agents.dispose(key);
    }
  }

  /**
   * Clear all runtime state for one conversation (releaseScheduled and dispose only; idle reclaim
   * keeps it). Does not dispose the agent — the caller's job.
   */
  private releaseState(id: ConversationId): void {
    this.conversations.delete(id);
    this.tokens.release(id);
    this.progress.forget(id);
    this.turns.release(id);
    this.status.forget(id);
  }
}

/**
 * An explicit `/name` is consumed, so the agent gets a clean prompt; `bare` is set when nothing
 * (no text, no attachment) followed it.
 */
function stripAgentPrefix(choice: AgentChoice, msg: InboundMessage): { msg: InboundMessage; bare?: string } {
  if (!choice.explicit) return { msg };
  const parsed = parseTextCommand(msg.content);
  const bare = parsed && !parsed.rest && !(msg.attachments?.length ?? 0) ? parsed.name : undefined;
  return { msg: { ...msg, content: parsed?.rest ?? '' }, ...(bare !== undefined ? { bare } : {}) };
}
