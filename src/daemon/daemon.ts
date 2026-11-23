import path from 'node:path';
import type { AgentDef, Config, HostDef } from '../config/schema.js';
import { accessUnrestricted, agentDisplayName, findAgent } from '../config/schema.js';
import { configDir, readConfig, readRawConfigIfExists, UNRESTRICTED_WARNING, type ReadConfig } from '../config/load.js';
import { applyConfig, describeReload, diffConfig } from './config-reload.js';
import type { HistoryStore } from '../history/store.js';
import {
  agentCommandSpecs,
  agentForCommand,
  DAEMON_COMMANDS,
  genericCommandSpecs,
  routeCommandSpecs,
  routeCommandAgent,
  type CommandSurface,
} from '../core/command-translate.js';
import { parsePickButtonId } from '../core/button-id.js';
import { offlinePlaces } from '../core/agent-menu.js';
import { canReach } from '../remote/reachable.js';
import { HostAvailability } from './host-availability.js';
import type {
  HistoryPanel,
  PlatformAdapter,
  ReviewPanel,
  SchedulePanel,
  SchedulePanelDetailResult,
  SchedulePanelFormContext,
  SchedulePanelTask,
  SchedulePanelTaskDetail,
} from '../platform/adapter.js';
import { OutboundPacer } from '../core/outbound-pacer.js';
import { splitIntoChunks } from '../core/stream-buffer.js';
import { formatEmptyCatalog, formatSkillCatalog } from '../core/skills-catalog.js';
import { expandRemoteHome, remoteAgentEnv, remoteAgentHome, resolveConversationCwd } from './agent-common.js';
import { knownHostsFileOf, remoteHosts } from './remote-hosts.js';
import { hostsWithConfiguredAgents, refreshPods } from './pods.js';
import { peerName, readKnownHosts, syncPeers } from './pod-peers.js';
import { gatewayKeyLine } from './pod-admin.js';
import { readPods } from '../config/pods.js';
import {
  agentHome,
  opencodeSkillDirs,
  remoteOpencodeSkillDirs,
  scanRemoteSkillDirs,
  scanSkillDirs,
  skillDirsFor,
} from './skills-scan.js';
import { withOutboundPacing } from './paced-adapter.js';
import type {
  AgentCommand,
  ButtonInteraction,
  CommandInteraction,
  ConversationId,
  InboundMessage,
  SlashCommandSpec,
  TopicKillResult,
} from '../types.js';
import {
  addressOf,
  formatAddress,
  parseTarget,
  type ConversationAddress,
  type ConversationRef,
} from '../core/conversation.js';
import type { AgentFactory } from './agent.js';
import { ConversationRegistry } from './conversation.js';
import type { ConversationStore } from './conversation-store.js';
import type { WorkdirUsageStore } from './workdir-usage.js';
import { IpcServer } from '../ipc/server.js';
import { startSkillSweep } from './skill-lifecycle.js';
import { ReviewService, reviewCandidatesFrom, type ReviewCandidate, type ReviewLane } from './review.js';
import { ReviewStateStore } from './review-state.js';
import { buildReviewPanel } from './review-panel.js';
import { buildHistoryPanel } from './history-panel.js';
import { buildFilesPanel } from './file-panel.js';
import { buildInstructionsPanel } from './instructions-panel.js';
import { standingInstructions } from './instructions.js';
import { selfInvocation } from './reverse-cli-shim.js';
import { activeSkillNames, type SkillRecord } from './skills-store.js';
import type { IpcAction } from '../ipc/protocol.js';
import { VoiceIntake } from './voice.js';
import { ScheduleService } from './schedule-service.js';
import { panelEditInput, panelForm, panelNewInput, panelTarget, panelTaskDetail, panelTasks } from './schedule-panel.js';
import { buildSkillsPanel } from './skills-panel.js';
import { buildGitPanel } from './git-panel.js';
import { readHead } from './git-head.js';
import { SkillsRepo, prepareSkillsRepo, skillsRemoteOf } from './skills-repo.js';
import { SkillLibrary } from './skill-library.js';
import { commandSurface, Delegation, type ExternalOwner } from './delegation.js';
import { ExternalCalls } from './external-calls.js';
import { ExternalMcp } from './external-mcp.js';
import { ExternalTopics } from './external-topics.js';
import { packageVersion } from '../remote/binaries.js';
import { encode } from '@toon-format/toon';
import type { ScheduleStore } from './schedule-store.js';
import { DRAIN_LIMIT_MS, describeInProgress, nothingInProgress, whenIdle, type InProgress } from './restart-drain.js';
import { envOf } from '../legacy-name.js';
import { RELOAD_POD_TIMEOUT_MS, type AskOutcome, type DaemonContext } from './daemon-context.js';
import {
  agentCommandToSpec,
  buildAskButtons,
  composeElicitPrompt,
  composePermissionPrompt,
  DaemonMenus,
  parseAskButtonId,
} from './daemon-menus.js';
import {
  COORDINATION_WRITE_ACTIONS,
  DaemonReverse,
  type GatewayQuery,
  type SessionsQuery,
} from './daemon-reverse.js';

export {
  agentCommandToSpec,
  buildAskButtons,
  composeElicitPrompt,
  composePermissionPrompt,
  COORDINATION_WRITE_ACTIONS,
  parseAskButtonId,
  parsePickButtonId,
  type AskOutcome,
};

// Slash-as-message platforms (Telegram) fire both message and command events with the same
// messageId; dedup within this window so one `/cmd` routes once.
const DEDUP_TTL_MS = 15_000;
const STARTUP_POD_TIMEOUT_MS = 60_000;
const PANEL_CHANNEL_LIMIT = 50;

export function buildRegisteredSpecs(cfg: Pick<Config, 'agents' | 'routing'>, surface?: CommandSurface): SlashCommandSpec[] {
  const specs = [...DAEMON_COMMANDS, ...genericCommandSpecs(surface), ...agentCommandSpecs(cfg), ...routeCommandSpecs(cfg)];
  // Dedup defensively: Telegram rejects the whole setMyCommands batch on a duplicate name.
  const seen = new Set<string>();
  return specs.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
}

/** Main daemon: wires platform, session registry, menus, reverse dispatch, and IPC server together. */
export class Daemon {
  private registry: ConversationRegistry;
  private ipc: IpcServer<ConversationAddress>;
  private readonly menus: DaemonMenus;
  private readonly reverse: DaemonReverse;
  private readonly availability = new HostAvailability({
    probe: (ssh) => canReach(ssh),
    isUp: (id) => remoteHosts.get(id)?.isUp ?? false,
    onChange: () => this.pushOfflineMachines(),
  });
  private offlineNames: ReadonlySet<string> = new Set();
  private skipRuntimeRegisterLogged = new Set<string>();
  private recentRouted = new Map<string, number>();
  private stopping = false;
  private skillSweepStop: (() => void) | undefined;
  private readonly skillsRepo = new SkillsRepo({ dir: configDir(), remote: () => skillsRemoteOf(this.config) });
  private skillsSyncStop: (() => void) | undefined;
  private readonly skillLibrary = new SkillLibrary();
  private signalCleanup: (() => void) | null = null;
  private drainCancel: (() => void) | null = null;
  private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  private readonly platforms: Map<string, PlatformAdapter>;
  private readonly pacer: OutboundPacer;
  private readonly voice: VoiceIntake;
  private readonly schedules?: ScheduleService;
  private readonly reviews?: ReviewService;
  private readonly reviewState?: ReviewStateStore;
  private readonly socketPath: string;
  private podsRead: Promise<unknown> = Promise.resolve();
  private readonly podReads = new Map<string, { at: Date; note?: string }>();
  private readonly delegation: Delegation;
  private readonly externalTopics = new ExternalTopics(path.join(configDir(), 'external-topics.json'));
  private readonly externalCalls: ExternalCalls;
  private readonly externalMcp: ExternalMcp;
  private renderTool: (action: IpcAction, data: unknown) => string = (_action, data) => encode(data);

  constructor(
    private readonly config: Config,
    platforms: Map<string, PlatformAdapter>,
    agents: AgentFactory,
    socketPath: string,
    private readonly store?: ConversationStore,
    workdirUsage?: WorkdirUsageStore,
    schedules?: { store: ScheduleStore; runsDir: string },
    private readonly history?: HistoryStore
  ) {
    const clock = {
      now: () => Date.now(),
      schedule: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    };
    this.clock = clock;
    this.pacer = new OutboundPacer(config.outbound, clock);
    this.platforms = new Map(
      [...platforms].map(([id, adapter]) => [id, withOutboundPacing(adapter, this.pacer)])
    );

    this.voice = new VoiceIntake(config, {
      platforms: this.platforms,
      deliver: (msg) => this.registry.route(msg, { transcript: true }),
      clock,
    });

    this.registry = new ConversationRegistry(
      config,
      this.platforms,
      agents,
      clock,
      this.buildRegistryHooks(),
      store,
      workdirUsage,
      undefined,
      history
    );
    this.delegation = this.buildDelegation(config, clock);
    ({ calls: this.externalCalls, mcp: this.externalMcp } = this.buildExternal(clock));
    if (schedules) {
      this.schedules = new ScheduleService(
        config,
        this.platforms,
        this.registry,
        clock,
        schedules.store,
        schedules.runsDir,
        (platform, address) => this.externalTopics.get(platform, address) !== undefined
      );
    }
    if (history) {
      this.reviewState = new ReviewStateStore(path.join(configDir(), 'reviews.json'));
      this.reviews = new ReviewService({
        config,
        history,
        state: this.reviewState,
        clock,
        candidates: () => this.reviewCandidates(),
        notify: (lane, text) => this.notifyReview(lane, text),
        writeSkills: (fn) => this.skillsRepo.write(fn),
        standing: () => standingInstructions(),
        searchMisses: (conversation, since) => this.skillLibrary.missesOf(conversation, since),
      });
    }

    const ctx = this.buildContext();
    this.menus = new DaemonMenus(ctx);
    this.reverse = new DaemonReverse(ctx);

    this.socketPath = socketPath;
    remoteHosts.configure(config, socketPath);
    this.watchHosts();
    const instances = new Set(Object.keys(config.platforms));
    this.ipc = new IpcServer<ConversationAddress>(socketPath, {
      resolveAddress: (token, rawOverride) => {
        // Parse `--channel` here (not in `ipc/`) so `ipc/` stays free of `core/` imports.
        const override = rawOverride == null ? undefined : parseTarget(rawOverride, instances);
        this.reverse.setResolved(this.registry.conversationForToken(token), override?.platform);
        return this.registry.resolveAddress(token, override?.address);
      },
      handle: (action, address) => this.reverse.handleReverse(action, address),
    });
  }

  private buildRegistryHooks() {
    return {
      onAvailableCommands: (_id: ConversationId, agentId: string, cmds: AgentCommand[]) =>
        this.onAgentCommands(agentId, cmds),
      onPickerRequest: (id: ConversationId, agentId: string, msg: InboundMessage) =>
        this.menus.onPickerRequest(id, agentId, msg),
      onSkillsRequest: (id: ConversationId, agentId: string, msg: InboundMessage) =>
        this.onSkillsRequest(id, agentId, msg),
      onElicitRequest: (
        id: ConversationId,
        platform: PlatformAdapter,
        address: ConversationAddress,
        request: Parameters<DaemonMenus['onElicitRequest']>[3]
      ) => this.menus.onElicitRequest(id, platform, address, request),
      onPermissionRequest: (
        id: ConversationId,
        platform: PlatformAdapter,
        address: ConversationAddress,
        request: Parameters<DaemonMenus['onPermissionRequest']>[3]
      ) => this.menus.onPermissionRequest(id, platform, address, request),
      // Idle reclaim guard: a pending `ask` holds work outside any turn while a CLI process sits blocked on a button.
      hasPendingWork: (id: ConversationId) => this.menus.hasPendingWork(id),
      answerPendingAsk: (id: ConversationId, text: string) => this.menus.answerPendingAskWithText(id, text),
      cancelPendingAsks: (id: ConversationId, reason: string) => this.menus.cancelPendingAsks(id, reason),
      supersedeProposals: (id: ConversationId) => this.delegation.personSpoke(id),
      retireWorkdirMenus: (id: ConversationId) => this.menus.retireWorkdirMenusFor(id, 'session-started'),
      onDelegationSettingChanged: () => this.delegation.forgetConfirmations(),
      onModelMenuRequest: (
        id: ConversationId,
        agentId: string,
        msg: InboundMessage,
        selector: Parameters<DaemonMenus['onModelMenuRequest']>[3]
      ) => this.menus.onModelMenuRequest(id, agentId, msg, selector),
      onEffortMenuRequest: (
        id: ConversationId,
        agentId: string,
        msg: InboundMessage,
        selector: Parameters<DaemonMenus['onEffortMenuRequest']>[3]
      ) => this.menus.onEffortMenuRequest(id, agentId, msg, selector),
      onModelSet: (id: ConversationId) => this.schedules?.notePersonModel(id),
      onSettingMenuRequest: (
        id: ConversationId,
        msg: InboundMessage,
        menu: Parameters<DaemonMenus['onSettingMenuRequest']>[2]
      ) => this.menus.onSettingMenuRequest(id, msg, menu),
      onReloadRequest: async () => (await this.reloadAll()).summary,
      onScheduleSetting: (id: ConversationId, msg: InboundMessage, args: string[], canMenu: boolean) =>
        this.menus.onScheduleSetting(id, msg, args, canMenu),
      scheduleSummary: () =>
        this.schedules ? `⏰ \`/setting schedule\` — ${this.schedules.tasks().length} scheduled task(s)` : undefined,
      onWorkdirMenuRequest: (
        id: ConversationId,
        agentId: string,
        conv: ConversationRef,
        menu: Parameters<DaemonMenus['onWorkdirMenuRequest']>[3]
      ) => this.menus.onWorkdirMenuRequest(id, agentId, conv, menu),
      onAgentMenuRequest: (
        id: ConversationId,
        msg: InboundMessage,
        menu: Parameters<DaemonMenus['onAgentMenuRequest']>[2]
      ) => this.menus.onAgentMenuRequest(id, msg.conversation, menu),
      offlinePlaces: () => this.offlineNames,
      takeVoice: (id: ConversationId, msg: InboundMessage) => this.voice.take(id, msg),
      supersedeVoice: (id: ConversationId) => this.voice.supersede(id),
      cancelPendingVoice: (id: ConversationId, reason: string) => this.voice.cancel(id, reason),
      onNeedsPerson: (id: ConversationId) => this.delegation.childChanged(id),
      onPersonWords: (
        id: ConversationId,
        words: Parameters<Delegation['personWrote']>[1]
      ) => this.delegation.personWrote(id, words),
      stopSubAgents: (id: ConversationId) => this.delegation.stopOpened(id),
      onCooldownOver: (agentId: string) => this.delegation.cooldownOver(agentId),
    };
  }

  private buildDelegation(
    config: Config,
    clock: { now(): number; schedule(fn: () => void, ms: number): () => void }
  ): Delegation {
    return new Delegation({
      config,
      platforms: this.platforms,
      registry: this.registry,
      clock,
      history: this.history,
      currentContext: (id) => {
        const agent = this.store?.boundAgent(id);
        if (!agent) return undefined;
        return { agent, generation: this.store?.conversationGeneration(id) ?? 0 };
      },
      questionOf: (id) => this.menus.questionOf(id),
      externalOf: (platform, address) => this.externalOwner(platform, address),
      headOf: async (id) => {
        const ws = this.registry.workspaceOf(id);
        return ws ? readHead(ws) : undefined;
      },
      // Buttons only (security invariant 6): a typed reply is the user's next message to the agent, never a start confirmation.
      confirm: async ({ adapter, address, conversation, text, labels, timeoutMs, signal }) => {
        const outcome = await this.menus.askButtons(adapter, address, text, labels, timeoutMs, conversation, {
          acceptsText: false,
          timeoutNote: '(expired — nothing was started)',
          signal,
          kind: 'dispatch',
        });
        return outcome?.kind === 'option' ? (outcome.labels[0] ?? null) : null;
      },
    });
  }

  private buildContext(): DaemonContext {
    return {
      config: this.config,
      platforms: this.platforms,
      registry: this.registry,
      store: this.store,
      history: this.history,
      voice: this.voice,
      schedules: this.schedules,
      delegation: this.delegation,
      externalTopics: this.externalTopics,
      skillsRepo: this.skillsRepo,
      skillLibrary: this.skillLibrary,
      offlineNames: () => this.offlineNames,
      askButtons: (platform, address, prompt, labels, timeoutMs, conversationId, opts) =>
        this.menus.askButtons(platform, address, prompt, labels, timeoutMs, conversationId, opts),
      notifySkillArchived: (skill, reason) => this.notifySkillArchived(skill, reason),
      reloadAll: () => this.reloadAll(),
      podList: () => this.podList(),
    };
  }

  private buildExternal(clock: { now(): number }): { calls: ExternalCalls; mcp: ExternalMcp } {
    const calls = new ExternalCalls({
      config: this.config,
      platforms: this.platforms,
      topics: this.externalTopics,
      conversationAt: (platform, address) => this.registry.conversationAt(platform, address),
      delegation: this.delegation,
      skills: this.skillLibrary,
      sessions: (action) => this.reverse.handleSessionsQuery(action),
      reverse: (action, target) => this.reverse.handleExternalReverse(action, target),
      render: (action, data) => this.renderTool(action, data),
      now: () => clock.now(),
    });
    const mcp = new ExternalMcp({
      settings: () => this.config.mcp,
      env: () => process.env,
      // A caller's token must not be a web UI login secret (security invariant 11).
      reserved: () => Object.values(this.config.platforms).flatMap((p) => (p.type === 'webui' ? [p.token] : [])),
      call: (caller, action) => calls.call(caller, action),
      libraryLine: () => calls.libraryLine(),
      version: packageVersion(),
    });
    return { calls, mcp };
  }

  // Keyed by platform + address, never by conversation id: under per_channel an id names the whole channel (security invariant 11).
  private externalOwner(platform: string, address: ConversationAddress): ExternalOwner | undefined {
    const t = this.externalTopics.get(platform, address);
    return t && { caller: t.caller, platform: t.platform, address: t.address, title: t.title };
  }

  renderToolsWith(render: (action: IpcAction, data: unknown) => string): void {
    this.renderTool = render;
  }

  async run(): Promise<void> {
    this.startSkillsRepo();
    for (const [id, adapter] of this.platforms) {
      adapter.onMessage((msg) => this.onInbound(msg));
      adapter.onButton((ev) => this.onButton(ev));
      adapter.onCommand((ev) => this.onCommand(ev));
      adapter.useWorkdirLookup?.((ref) => this.registry.workdirForRef(ref));
      adapter.useLivenessLookup?.((ref) => this.registry.liveForRef(ref));
      adapter.useIdleReclaim?.((ref) => this.registry.reclaimIdleForRef(ref));
      this.wireTopicKill(adapter);
      adapter.useScheduleLookup?.((ref) => this.schedules?.targets(ref) ?? false);
      adapter.usePendingQueueActions?.({
        recall: (ref, messageId) => this.registry.recallPendingForRef(ref, messageId),
        sendNow: (ref, messageId, opts) => this.registry.sendNowPendingForRef(ref, messageId, opts),
      });
      this.wirePanels(adapter, id);
      await adapter.start();
      console.log(`[daemon] platform instance "${id}" (${adapter.platformType}) started`);
    }
    await this.registerCommands();
    this.registry.warmRemoteScans();
    await this.ipc.start();
    await this.externalMcp
      .configure()
      .catch((e: Error) => console.error(`[external-mcp] ⚠️  not listening: ${e.message}`));
    // After platforms and IPC are up: notices need adapters, and scheduled continues need working reverse commands.
    const interrupted = this.registry.recoverInterruptedTurns();
    if (interrupted > 0) console.log(`[daemon] ${interrupted} turn(s) were cut off by the last shutdown`);
    // After platforms and IPC are up: catch-up runs need somewhere to post and working reverse commands.
    this.schedules?.scheduler.start();
    this.reviews?.start();
    // Skip the daily managed-skill sweep in test workers (non-CLI entrypoints must not touch the operator's config dir).
    if (selfInvocation() && !envOf('NO_SKILL_LINK')) {
      this.skillSweepStop = startSkillSweep((skill, reason) => this.notifySkillArchived(skill, reason));
    }
    void this.refreshPods(STARTUP_POD_TIMEOUT_MS)
      .then((r) => {
        for (const n of r.notes) console.warn(`[pods] ${n}`);
        if (r.changed) this.reloadConfig();
      })
      .catch((e: Error) => console.warn(`[pods] not read at startup: ${e.message}`));
    this.installSignalHandlers();
  }

  private wireTopicKill(adapter: PlatformAdapter): void {
    adapter.useTopicKill?.((ref, confirmed) => this.killTopicTree(ref, confirmed));
  }

  private watchHosts(): void {
    remoteHosts.onConnection((id, up) => (up ? this.availability.connected(id) : this.availability.dropped(id)));
    this.availability.configure(this.config.hosts ?? {});
  }

  private pushOfflineMachines(): void {
    const machines = offlinePlaces(this.config.agents, this.availability.offline());
    const names = new Set(machines.map((m) => m.name));
    if ([...names].join(',') !== [...this.offlineNames].join(',')) {
      console.log(`[remote] offline: ${names.size > 0 ? [...names].join(', ') : 'none'}`);
    }
    this.offlineNames = names;
    for (const [id, adapter] of this.platforms) {
      try {
        adapter.setOfflineMachines?.(machines);
      } catch (e) {
        console.warn(`[remote] could not tell ${id} which machines are offline:`, e instanceof Error ? e.message : e);
      }
    }
  }

  private killTopicTree(ref: ConversationRef, confirmed: ReadonlySet<string>): TopicKillResult[] {
    const address = { channel: ref.channel, ...(ref.thread !== undefined ? { thread: ref.thread } : {}) };
    const conversation = this.registry.conversationAt(ref.platform, address);
    if (!conversation) return [];
    console.log(`[reclaim] ${conversation.key}: ending ${confirmed.size} confirmed agent(s) under this topic from the web UI`);
    return this.delegation.endTopic(conversation.key, confirmed, { platform: ref.platform, address });
  }

  private installSignalHandlers(): void {
    const onSignal = (signal: NodeJS.Signals): void => {
      if (signal === 'SIGTERM' && !this.drainCancel && this.beginDrain()) return;
      console.log(`[daemon] received ${signal}, shutting down gracefully…`);
      this.exitAfterStop(signal === 'SIGINT' ? 130 : 143);
    };
    const onSigint = (): void => onSignal('SIGINT');
    const onSigterm = (): void => onSignal('SIGTERM');
    const onSighup = (): void => {
      if (this.stopping || this.drainCancel) {
        console.log('[daemon] received SIGHUP while shutting down, ignoring');
        return;
      }
      console.log('[daemon] received SIGHUP, reloading config…');
      void this.reloadAll().catch((e: unknown) =>
        console.warn('[daemon] SIGHUP reload failed:', e instanceof Error ? e.message : e)
      );
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    // On Windows SIGHUP signals console window close rather than reload.
    if (process.platform !== 'win32') process.on('SIGHUP', onSighup);
    this.signalCleanup = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (process.platform !== 'win32') process.removeListener('SIGHUP', onSighup);
    };
  }

  private exitAfterStop(code: number): void {
    void this.stop()
      .catch((e) => console.error('[daemon] shutdown failed:', e instanceof Error ? e.message : e))
      .finally(() => process.exit(code));
  }

  private inProgress(): InProgress {
    return { turns: this.registry.turnsInProgress(), runs: this.schedules?.scheduler.inFlight ?? 0 };
  }

  private beginDrain(): boolean {
    const now = this.inProgress();
    if (nothingInProgress(now)) return false;
    this.registry.beginDrain();
    this.schedules?.scheduler.hold();
    console.log(
      `[daemon] received SIGTERM with ${describeInProgress(now)} in progress: stopping once ${now.turns + now.runs === 1 ? 'it finishes' : 'they finish'}, at most ${DRAIN_LIMIT_MS / 60_000} min. Another SIGTERM, or SIGINT, stops now.`
    );
    this.drainCancel = whenIdle(
      () => this.inProgress(),
      this.clock,
      (left) => {
        if (nothingInProgress(left)) console.log('[daemon] nothing in progress any more, shutting down gracefully…');
        else console.warn(`[daemon] ${describeInProgress(left)} still in progress after ${DRAIN_LIMIT_MS / 60_000} min; shutting down anyway…`);
        this.exitAfterStop(143);
      }
    );
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.drainCancel?.();
    this.signalCleanup?.();
    this.signalCleanup = null;
    this.skillSweepStop?.();
    this.skillSweepStop = undefined;
    this.skillsSyncStop?.();
    this.skillsSyncStop = undefined;
    // Stop reviews and scheduler first so no new work starts or posts to platforms about to shut down.
    this.reviews?.stop();
    this.schedules?.scheduler.stop();
    await this.externalMcp.stop();
    await this.ipc.stop();
    // Drain queued outbound writes before stopping adapters so pending replies are not lost; bounded by outbound.drainMs.
    const drained = await this.pacer
      .drain(this.config.outbound.drainMs)
      .catch(() => ({ delivered: 0, abandoned: 0 }));
    if (drained.delivered > 0 || drained.abandoned > 0) {
      console.log(
        `[daemon] outbound drain: ${drained.delivered} delivered, ${drained.abandoned} abandoned`
      );
    }
    for (const [id, adapter] of this.platforms) {
      await adapter.stop().catch((e) =>
        console.error(`[daemon] failed to stop platform instance "${id}":`, e instanceof Error ? e.message : e)
      );
    }
    this.menus.clearMenus();
    this.voice.dispose();
    // Clear pending asks after IPC/platforms stop and resolve null so blocked CLI callers do not hang forever.
    this.menus.clearAsks();
    this.delegation.dispose();
    this.registry.dispose();
    // Close history after registry.dispose() so unwinding turns flush their last row and SQLite WAL closes cleanly.
    this.history?.close();
    // Give stop signals sent to remote agents a short window to flush before closing SSH connections.
    await remoteHosts.flushAll(2_000);
    remoteHosts.closeAll();
    this.availability.stop();
  }

  // Thin forwarding accessors kept for internal callers and unit tests.
  private get pendingPicks() {
    return this.menus.pendingPicks;
  }

  private questionOf(conversationId: ConversationId): string | undefined {
    return this.menus.questionOf(conversationId);
  }

  private handleGatewayQuery(action: GatewayQuery, address: ConversationAddress): Promise<unknown> {
    return this.reverse.handleGatewayQuery(action, address);
  }

  private handleSessionsQuery(action: SessionsQuery): unknown {
    return this.reverse.handleSessionsQuery(action);
  }

  private startSkillsRepo(): void {
    if (!selfInvocation()) return;
    prepareSkillsRepo(configDir());
    this.skillsSyncStop = this.skillsRepo.start();
  }

  private notifySkillArchived(skill: SkillRecord, reason: 'unused' | 'manual'): void {
    const source = skill.source;
    if (!source?.platform || !source.address) {
      console.log(`[skills] archived "${skill.name}" (no source conversation to tell)`);
      return;
    }
    const adapter = this.platforms.get(source.platform);
    if (!adapter) {
      console.log(`[skills] archived "${skill.name}" (its conversation was on ${source.platform}, which is no longer configured)`);
      return;
    }
    const why = reason === 'unused' ? 'was archived after 30 days unused' : 'was archived';
    void adapter
      .sendMessage(source.address, `Skill "${skill.name}" ${why}. Restore it with \`fleetherd skills restore ${skill.name}\`.`)
      .catch((e: unknown) =>
        console.warn(`[skills] could not tell ${source.platform} about "${skill.name}":`, e instanceof Error ? e.message : e)
      );
  }

  async reloadAll(): Promise<{ ok: boolean; summary: string }> {
    let notes: string[] = [];
    try {
      const next = readConfig().config;
      remoteHosts.configure(next, this.socketPath);
      notes = (await this.refreshPods(RELOAD_POD_TIMEOUT_MS, next.hosts)).notes;
    } catch (e) {
      console.warn(`[pods] not read before this reload: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
    const reload = this.reloadConfig();
    if (!reload.ok || notes.length === 0) return reload;
    return { ok: true, summary: [reload.summary, ...notes.map((n) => `- ⚠️ pods: ${n}`)].join('\n') };
  }

  private refreshPods(
    timeoutMs: number,
    hosts: Record<string, HostDef> = this.config.hosts ?? {}
  ): Promise<{ changed: boolean; notes: string[] }> {
    const run = async (): Promise<{ changed: boolean; notes: string[] }> => {
      const r = await refreshPods({
        dir: configDir(),
        hostIds: remoteHosts.ids(),
        host: (id) => remoteHosts.get(id),
        configured: hostsWithConfiguredAgents(readRawConfigIfExists()),
        timeoutMs,
      });
      const at = new Date();
      for (const id of r.read) this.podReads.set(id, { at });
      for (const note of r.notes) this.podReads.set(note.slice(0, note.indexOf(':')), { at, note });
      const meshNotes = await syncPeers({
        pods: readPods(configDir()),
        hosts,
        reachable: r.read,
        host: (id) => remoteHosts.get(id),
        knownHostsText: (def) => readKnownHosts(knownHostsFileOf(def)),
      });
      return { changed: r.changed, notes: [...r.notes, ...meshNotes] };
    };
    const next = this.podsRead.then(run, run);
    this.podsRead = next.catch(() => undefined);
    return next;
  }

  reloadConfig(): { ok: boolean; summary: string } {
    let read: ReadConfig;
    try {
      read = readConfig();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`[reload] config.yaml not reloaded: ${why}`);
      return { ok: false, summary: `config.yaml was not reloaded — nothing changed.\n${why}` };
    }
    const next = read.config;
    const diff = diffConfig(this.config, next);
    const commandsBefore = JSON.stringify(buildRegisteredSpecs(this.config));
    const wasRestricted = !accessUnrestricted(this.config);

    read.commitEnv();
    applyConfig(this.config, next);
    remoteHosts.configure(this.config, this.socketPath);
    this.availability.configure(this.config.hosts ?? {});
    this.pushOfflineMachines();
    this.registry.warmRemoteScans();

    if (diff.sections.includes('session')) this.registry.idleTimeoutChanged();
    if (diff.sections.includes('delegation')) this.delegation.forgetConfirmations();
    if (diff.sections.includes('mcp')) {
      void this.externalMcp.configure().catch((e: Error) => console.error(`[external-mcp] ⚠️  not listening: ${e.message}`));
    }
    const respawn = this.registry.respawnAgents(new Set([...diff.agentsChanged, ...diff.agentsRemoved]));
    // Re-register only when the spec set changed; Telegram and Discord rate-limit command registration.
    if (JSON.stringify(buildRegisteredSpecs(this.config)) !== commandsBefore) void this.registerCommands();

    const warnings: string[] = [];
    if (wasRestricted && accessUnrestricted(this.config)) {
      console.warn(UNRESTRICTED_WARNING);
      warnings.push('access.allowFrom is now empty: anyone who can message the bot can run an agent with full tool access');
    }
    const orphaned = (this.schedules?.tasks() ?? []).filter(
      (t) => t.run.kind === 'agent' && diff.agentsRemoved.includes(t.run.agent)
    );
    if (orphaned.length) {
      warnings.push(`scheduled task(s) ${orphaned.map((t) => t.id).join(', ')} run a removed agent; they will fail until changed or removed`);
    }

    const summary = describeReload(diff, respawn, read.envChanges, warnings);
    console.log(`[reload] ${summary.replace(/\n/g, ' | ')}`);
    return { ok: true, summary };
  }

  private podList(): { gatewayKey: string; pods: Array<Record<string, string>> } {
    const pods = readPods(configDir());
    const explicit = hostsWithConfiguredAgents(readRawConfigIfExists());
    const rows = Object.entries(this.config.hosts ?? {}).map(([id, def]) => {
      const read = this.podReads.get(id);
      const from = explicit.has(id) ? 'config.yaml' : pods[id]?.source === 'file' ? 'pod.yaml' : pods[id]?.source === 'probe' ? 'PATH' : '-';
      return {
        pod: id,
        ssh: def.ssh,
        agents: this.config.agents.filter((a) => a.host === id).map((a) => a.id).join(' ') || '-',
        from,
        peer: pods[id]?.peer ? peerName(id) : '-',
        lastRead: !read ? 'not yet' : `${read.at.toISOString().slice(0, 19)}Z ${read.note ? `kept old: ${read.note.slice(id.length + 2)}` : 'ok'}`,
      };
    });
    return { gatewayKey: gatewayKeyLine(), pods: rows };
  }

  private reviewCandidates(): ReviewCandidate[] {
    const now = Date.now();
    const live = this.registry.reviewFacts(now);
    return reviewCandidatesFrom(this.store?.entries() ?? [], live, (key) => this.history?.sessionOf(key), now);
  }

  private async notifyReview(lane: ReviewLane, text: string): Promise<void> {
    const adapter = this.platforms.get(lane.platform);
    if (!adapter) throw new Error(`platform "${lane.platform}" is not configured any more`);
    await adapter.sendMessage(lane.thread ? { channel: lane.channel, thread: lane.thread } : { channel: lane.channel }, text);
  }

  private schedulePanel(instance: string): SchedulePanel | undefined {
    const schedules = this.schedules;
    if (!schedules) return undefined;
    const list = (): SchedulePanelTask[] =>
      panelTasks(schedules.tasks(), schedules.now(), (id) => schedules.scheduler.isRunning(id), instance);
    const form = (): SchedulePanelFormContext =>
      panelForm({
        agents: this.config.agents,
        hosts: Object.keys(this.config.hosts ?? {}),
        channels: this.registry.listChannels({ limit: PANEL_CHANNEL_LIMIT }).channels,
        instance,
        tz: schedules.defaultZone(),
        agent: this.config.routing.default,
      });
    const detail = (id: string): SchedulePanelTaskDetail | undefined => {
      const task = schedules.get(id);
      if (!task) return undefined;
      return panelTaskDetail(task, {
        now: schedules.now(),
        running: schedules.scheduler.isRunning(id),
        instance,
        form: form(),
        laneOf: (key) => this.registry.laneFor(key),
      });
    };
    const instances = new Set(Object.keys(this.config.platforms));
    const answer = async (write: () => Promise<{ id: string }>): Promise<SchedulePanelDetailResult> => {
      try {
        const { id } = await write();
        const page = detail(id);
        if (!page) return { ok: false, error: `#${id} was removed just after this change` };
        return { ok: true, detail: page, tasks: list() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    return {
      list,
      op: (id, action, tags) => {
        try {
          if (action === 'tags') schedules.setTags(id, tags ?? []);
          else schedules.op(id, action, undefined, false);
          return { ok: true, tasks: list() };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      detail,
      form,
      add: (task) => answer(() => schedules.addFromPanel(panelNewInput(task), panelTarget(task.target, instance, instances))),
      edit: (id, change) =>
        answer(() =>
          schedules.editFromPanel(
            id,
            panelEditInput(change),
            change.target !== undefined ? panelTarget(change.target, instance, instances) : undefined
          )
        ),
    };
  }

  private wirePanels(adapter: PlatformAdapter, id: string): void {
    const schedulePanel = this.schedulePanel(id);
    if (schedulePanel) adapter.useSchedulePanel?.(schedulePanel);
    adapter.useSkillsPanel?.(
      buildSkillsPanel({
        notifyArchived: (skill) => this.notifySkillArchived(skill, 'manual'),
        write: (fn) => this.skillsRepo.write(fn),
      })
    );
    const reviewPanel = this.reviewPanel(id);
    if (reviewPanel) adapter.useReviewPanel?.(reviewPanel);
    const historyPanel = this.historyPanel(id);
    if (historyPanel) adapter.useHistoryPanel?.(historyPanel);
    adapter.useAgentCatalog?.((ref) => this.registry.agentCatalogForRef(ref));
    adapter.useModelPicker?.({
      list: (ref) => this.registry.modelPickerForRef(ref),
      choose: (ref, value) => this.registry.chooseModelForRef(ref, value),
    });
    adapter.useOptionPicker?.({
      peek: (ref) => this.registry.optionStatusForRef(ref),
      list: (ref) => this.registry.optionsForRef(ref),
      choose: (ref, optId, value) => this.registry.chooseOptionForRef(ref, optId, value),
    });
    adapter.useTurnChanges?.({
      status: (ref, turn) => this.registry.turnChangesStatusForRef(ref, turn),
      file: (ref, turn, filePath) => this.registry.turnChangesFileForRef(ref, turn, filePath),
      forget: (ref) => this.registry.turnChangesForgetForRef(ref),
    });
    adapter.useGitPanel?.(buildGitPanel((ref) => this.registry.workspaceForRef(ref)));
    adapter.useVoiceTranscriber?.({
      enabled: () => this.voice.isConfigured(),
      transcribe: (bytes, mime) => this.voice.transcribeBuffer(bytes, mime),
    });
    this.wireWritingPanels(adapter, id);
  }

  /** Opt-in write panels: never injected while disabled (security invariants 9 & 10). */
  private wireWritingPanels(adapter: PlatformAdapter, id: string): void {
    const platform = this.config.platforms[id];
    if (platform?.type !== 'webui') return;
    if (platform.files.enabled) {
      adapter.useFilesPanel?.(
        buildFilesPanel({
          instance: id,
          roots: platform.files.roots,
          workspaceForRef: (ref) => this.registry.workspaceForRef(ref),
        })
      );
    }
    if (platform.instructions.enabled) {
      adapter.useInstructionsPanel?.(buildInstructionsPanel({ instance: id, agents: () => this.config.agents }));
    }
  }

  private reviewPanel(instance: string): ReviewPanel | undefined {
    const history = this.history;
    const reviews = this.reviews;
    if (!history || !reviews) return undefined;
    const state = this.reviewState;
    return buildReviewPanel({
      history,
      instance,
      enabled: () => reviews.enabled(),
      dismissed: () => state?.dismissedPreferences() ?? new Set<string>(),
      dismiss: (text) => state?.dismissPreference(text),
      standing: () => standingInstructions(),
      activeSkills: () => new Set(activeSkillNames()),
    });
  }

  private historyPanel(instance: string): HistoryPanel | undefined {
    const history = this.history;
    if (!history) return undefined;
    return buildHistoryPanel({ history, instance });
  }

  private onButton(ev: ButtonInteraction): void {
    this.menus.onButton(ev);
  }

  private onInbound(msg: InboundMessage): void {
    // Skip dedup when messageId is empty (e.g. Slack slash) so distinct events never collide.
    if (msg.messageId) {
      const now = Date.now();
      for (const [k, t] of this.recentRouted) {
        if (now - t > DEDUP_TTL_MS) this.recentRouted.delete(k);
      }
      const key = `${msg.conversation.platform}:${formatAddress(addressOf(msg.conversation))}:${msg.messageId}`;
      if (this.recentRouted.has(key)) return;
      this.recentRouted.set(key, now);
    }
    if (this.externalCalls.intercept(msg)) return;
    this.registry.route(msg);
  }

  private onCommand(ev: CommandInteraction): void {
    console.log(
      `[slash] received native command /${ev.name} (${ev.conversation.platform} ${formatAddress(addressOf(ev.conversation))})`
    );
    const input = String(ev.options.input ?? ev.options.raw ?? '').trim();
    const content = input ? `/${ev.name} ${input}` : `/${ev.name}`;
    const msg: InboundMessage = {
      conversation: ev.conversation,
      messageId: ev.messageId,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    };
    this.onInbound(msg);
    // Discord auto-deferred slash interactions require a followup ack or the UI reports "did not respond".
    if (this.platforms.get(ev.conversation.platform)?.capabilities.slashNeedsAck) {
      void ev.reply(`▸ /${ev.name}`).catch((e) =>
        console.error('[slash] interaction acknowledgement failed:', e instanceof Error ? e.message : e)
      );
    }
  }

  private onAgentCommands(agentId: string, cmds: AgentCommand[]): void {
    this.menus.setAgentCommands(agentId, cmds);
  }

  private onSkillsRequest(conversationId: ConversationId, agentId: string, msg: InboundMessage): void {
    const adapter = this.platforms.get(msg.conversation.platform);
    if (!adapter) return;
    const address = addressOf(msg.conversation);

    const def = findAgent(this.config, agentId);
    const label = agentDisplayName(def, agentId);

    void (async () => {
      const { dirs, found } = await this.findSkills(def, conversationId);

      const body = found.length === 0 ? formatEmptyCatalog(label, dirs) : formatSkillCatalog(label, found);
      console.log(`[skills] ${label}: ${found.length} from ${dirs.length} dir(s)`);

      const limit = adapter.capabilities.maxMessageLength;
      const parts = limit > 0 ? splitIntoChunks(body, limit) : [body];
      for (const part of parts) await adapter.sendMessage(address, part);
    })().catch((e) => console.error('[skills] reply failed:', e instanceof Error ? e.message : e));
  }

  private async findSkills(
    def: AgentDef | undefined,
    conversationId: ConversationId
  ): Promise<{ dirs: string[]; found: Awaited<ReturnType<typeof scanSkillDirs>> }> {
    const host = remoteHosts.hostFor(def);
    if (def && host) {
      const w = await host.ready();
      const home = remoteAgentHome(def, w);
      const cwd = expandRemoteHome(resolveConversationCwd(def, conversationId, this.store), w.home);
      const env = remoteAgentEnv(def);
      const configured = def.harness === 'opencode' ? await remoteOpencodeSkillDirs(host, home, env) : [];
      const dirs = skillDirsFor(def, { home, cwd, configured });
      return { dirs, found: await scanRemoteSkillDirs(host, dirs) };
    }
    const home = agentHome(def);
    const cwd = def ? resolveConversationCwd(def, conversationId, this.store) : home;
    const configured = def?.harness === 'opencode' ? await opencodeSkillDirs(home, process.env) : [];
    const dirs = skillDirsFor(def, { home, cwd, configured });
    return { dirs, found: await scanSkillDirs(dirs) };
  }

  private async registerCommands(): Promise<void> {
    const agentCmds = [
      ...agentCommandSpecs(this.config).map((s) => `/${s.name}→${agentForCommand(this.config, s.name) ?? '?'}`),
      ...routeCommandSpecs(this.config).map((s) => `/${s.name}→${routeCommandAgent(this.config, s.name) ?? '?'}`),
    ].join(' ');
    console.log(`[slash] agent commands from config: ${agentCmds || '(none)'}`);
    for (const [id, adapter] of this.platforms) {
      if (!adapter.capabilities.slashCommands) continue;
      if (adapter.capabilities.canRegisterSlashAtRuntime === false) {
        if (!this.skipRuntimeRegisterLogged.has(id)) {
          this.skipRuntimeRegisterLogged.add(id);
          console.log(
            `[slash] instance "${id}" requires out-of-band slash registration (App panel/manifest); skipping runtime registration; the receiving side still works.`
          );
        }
        continue;
      }
      const all = buildRegisteredSpecs(this.config, commandSurface(adapter));
      const cap = adapter.capabilities.maxSlashCommands ?? Infinity;
      let specs = all;
      if (all.length > cap) {
        const over = all.slice(cap).map((s) => s.name);
        specs = all.slice(0, cap);
        console.warn(
          `[slash] instance "${id}": command count ${all.length} exceeds the cap ${cap}; registering only the first ${cap}; ` +
            `not registered (still invokable as /cmd text): ${over.join(', ')}`
        );
      }
      try {
        const cfg = this.config.platforms[id];
        const guildId = cfg?.type === 'discord' ? cfg.commandGuildId : undefined;
        await adapter.registerCommands(specs, guildId ? { guildId } : undefined);
        console.log(`[slash] instance "${id}": registered ${specs.length} command(s)`);
      } catch (e) {
        console.error(`[slash] instance "${id}": registration failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
}
