import type { AgentDef } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import { HARNESSES } from './harness/index.js';
import { tMenus } from '../core/i18n/menus.js';
import { configDir, readRawConfigIfExists } from '../config/load.js';
import { podAgentModels, readPods } from '../config/pods.js';
import { agentGroups, agentListText, matchAgent } from '../core/agent-menu.js';
import { busyNote, formatUsageSnapshot } from '../core/busy-snapshot.js';
import {
  buildHelpText,
  customOptionFor,
  harnessCommandName,
  harnessHasPicker,
  isCliAnsweredCommand,
  isGenericCommand,
  isSessionQuery,
  needsNestedTopics,
  translateCommand,
  unconfiguredHarnessCommand,
  type CommandTranslation,
} from '../core/command-translate.js';
import { addressOf, type ConversationAddress, type ConversationRef } from '../core/conversation.js';
import { normalizeLocale, localeOf, type Locale } from '../core/i18n/index.js';
import { formatRuntimeFooter, formatTokens } from '../core/runtime-footer.js';
import { parseTextCommand } from '../core/text-command.js';
import {
  modelListAgent,
  resolveSettingKey,
  settingAckText,
  settingDetailText,
  settingOptions,
  settingTypedOnlyHint,
  settingUnknownKeyText,
  settingsListText,
  settingsMenuSurface,
  settingsRows,
  type PodModels,
  type SettingApplyResult,
  type SettingOption,
  type SettingRow,
  type SettingsContext,
} from '../core/settings.js';
import type { ConversationId, InboundMessage, MessageRef } from '../types.js';
import { SideQuestionRefused } from './agent.js';
import { resolveConversationCwd } from './agent-common.js';
import { formatAgyCliOutput, runAgyCliFor } from './agy-cli.js';
import type { ConversationContext, ConversationState } from './conversation-context.js';
import type { ConversationControls } from './conversation-controls.js';
import { withInputNote, type ConversationTurns } from './conversation-turns.js';
import { commandSurface } from './delegation-surface.js';
import { runQuotaCommandFor } from './quota-meter.js';
import type { AgentChoice } from './routing.js';
import { SettingsStore } from './settings-store.js';
import { sendAside } from './turn-runner.js';

const CONTEXT_CLEAR_RE = /^\/(new|clear)(@\S+)?$/;
const HELP_RE = /^\/help(@\S+)?$/;
const STOP_RE = /^\/stop(@\S+)?$/;
const KILL_RE = /^\/kill(@\S+)?$/;
const RECALL_RE = /^\/(recall|unqueue)(@\S+)?(?:\s+(all))?$/i;
const SENDNOW_RE = /^\/sendnow(@\S+)?$/i;
const RELOAD_RE = /^\/reload(@\S+)?$/;
const FORK_RE = /^\/fork(@\S+)?$/;

/** Accepted spellings; only the first of each is registered in the platform menu (the aliases trade). */
const SETTING_NAMES = new Set(['setting', 'settings', 'config']);
const WORKDIR_NAMES = new Set(['cd', 'dir', 'workdir']);
const AGENT_NAMES = new Set(['agent', 'agents']);
const TITLE_NAMES = new Set(['title', 'rename', 'topic']);
const SKILLS_NAMES = new Set(['skills', 'skill']);
/** `/setting schedule`: reached from the settings screen, but not a setting key, so none can collide. */
const SCHEDULE_SETTING_NAMES = new Set(['schedule', 'schedules', 'tasks', 'cron']);

/**
 * The slash commands route() meets before a turn: the ones the gateway answers itself
 * (DAEMON_COMMANDS — never forwarded), `/setting`, and the generic vocabulary translated into the
 * bound harness's own spelling, answered locally, or refused.
 */
export class ConversationCommands {
  /** The `/setting` writer; here because the registry side holds the Config and the live sessions. */
  private readonly settings: SettingsStore;

  constructor(
    private readonly ctx: ConversationContext,
    private readonly turns: ConversationTurns,
    private readonly controls: ConversationControls
  ) {
    // `/setting idle` must re-arm the sweeper, and a delegation change must void what Delegation remembered.
    this.settings = new SettingsStore(ctx.config, {
      onIdleTimeout: () => turns.rearmIdleSweeper(),
      onDelegationChanged: () => ctx.hooks?.onDelegationSettingChanged?.(),
      onPermissionsChanged: (agentId) => this.applyPermissionsLive(agentId),
    });
  }

  /**
   * Everything route() answers past the gate and before binding; true when no turn runs. The order
   * is load-bearing: daemon commands first (so `/oc /new` still clears and `/stop` reaches a question
   * it calls off), then the agent switch lock (so `/oc …` is refused, not filed as an answer), then a
   * pending question, then an unconfigured harness name.
   */
  intercept(key: ConversationId, msg: InboundMessage, address: ConversationAddress, choice: AgentChoice): boolean {
    return (
      this.answerDaemonCommand(key, msg, address, choice.agentId) ||
      this.refuseAgentSwitch(key, choice, address, msg) ||
      this.answersPendingQuestion(key, msg) ||
      this.reportUnconfiguredHarness(choice, msg, address)
    );
  }

  /**
   * DAEMON_COMMANDS, intercepted before the merger so `/new` and `/stop` work mid-turn; matched on
   * the prefix-stripped content so `/cc /new` composes.
   */
  private answerDaemonCommand(
    key: ConversationId,
    msg: InboundMessage,
    address: ConversationAddress,
    fallbackAgent: string
  ): boolean {
    const text = msg.content.trim();
    const conv = msg.conversation;
    const ack = (what: string, body: string): void => {
      void this.ctx.platforms
        .get(conv.platform)
        ?.sendMessage(address, body)
        .catch((e) => console.warn(`[conversation] failed to ack ${what}:`, e instanceof Error ? e.message : e));
    };

    if (CONTEXT_CLEAR_RE.test(text)) {
      const locale = localeOf(this.ctx.config);
      const agentId = this.ctx.boundAgentFor(key, fallbackAgent);
      // Before the reset: a question or transcript waiting here belongs to the context being discarded.
      this.callOffPending(key, 'context cleared');
      // What a `/stop` kept was written for that context too.
      const dropped = this.ctx.conversations.get(key)?.merger.dropKept() ?? [];
      this.ctx.resetConversation(key);
      console.log(`[conversation] ${key} context cleared by ${conv.platform}:${conv.user}`);
      ack('context clear', withInputNote(tMenus(locale, 'cmd_context_cleared'), [], dropped));
      // A reset is the one moment "where should this happen" costs nothing to ask.
      this.controls.afterRemoteListing(findAgent(this.ctx.config, agentId), () => this.controls.offerWorkdirMenu(key, agentId, conv));
      return true;
    }

    if (STOP_RE.test(text)) {
      ack('/stop', this.turns.stopAndReport(key, conv));
      return true;
    }

    if (KILL_RE.test(text)) {
      ack('/kill', this.turns.killAndReport(key, conv));
      return true;
    }

    if (this.answerQueueCommand(key, text, conv, ack)) return true;

    // Before the merger: a /fork queued behind a turn would copy whatever that turn left.
    if (FORK_RE.test(text)) {
      void this.controls.forkAndReport(key, msg, address, fallbackAgent).then((body) => ack('/fork', body));
      return true;
    }

    if (this.answerGatewayCommand(key, text, fallbackAgent, conv, address, ack)) return true;

    const setting = parseTextCommand(text);
    if (setting && SETTING_NAMES.has(setting.name.toLowerCase())) {
      this.handleSetting(key, setting.rest, fallbackAgent, address, msg);
      return true;
    }

    if (setting && this.answerPlacementCommand(key, setting, fallbackAgent, msg, ack)) return true;

    if (setting && TITLE_NAMES.has(setting.name.toLowerCase())) {
      void this.controls.applyTitleCommand(key, fallbackAgent, setting.rest, address, msg).then((answer) =>
        ack('/title', answer)
      );
      return true;
    }
    // `/skills` lists the agent's own vocabulary, which only the daemon holds (agentCommands).
    if (setting && SKILLS_NAMES.has(setting.name.toLowerCase())) {
      const agentId = this.ctx.boundAgentFor(key, fallbackAgent);
      this.ctx.hooks?.onSkillsRequest?.(key, agentId, msg);
      return true;
    }

    return false;
  }

  private answerQueueCommand(
    key: ConversationId,
    text: string,
    conv: ConversationRef,
    ack: (what: string, body: string) => void
  ): boolean {
    const recallMatch = RECALL_RE.exec(text);
    if (recallMatch) {
      ack('/recall', this.turns.recallAndReport(key, conv, recallMatch[3]?.toLowerCase() === 'all'));
      return true;
    }
    if (SENDNOW_RE.test(text)) {
      ack('/sendnow', this.turns.sendNowAndReport(key, conv));
      return true;
    }
    return false;
  }

  /** `/help` and `/reload`: about the gateway rather than this conversation's agent. */
  private answerGatewayCommand(
    key: ConversationId,
    text: string,
    fallbackAgent: string,
    conv: ConversationRef,
    address: ConversationAddress,
    ack: (what: string, body: string) => void
  ): boolean {
    if (HELP_RE.test(text)) {
      this.sendHelp(key, fallbackAgent, conv.platform, address);
      return true;
    }
    if (!RELOAD_RE.test(text)) return false;
    console.log(`[conversation] /reload by ${conv.platform}:${conv.user}`);
    const reload = this.ctx.hooks?.onReloadRequest;
    if (!reload) ack('/reload', tMenus(localeOf(this.ctx.config), 'cmd_reload_unavailable'));
    else void reload().then((summary) => ack('/reload', summary));
    return true;
  }

  /** Built from the tables that drive registration, so the menu and `/help` cannot drift apart. */
  private sendHelp(
    key: ConversationId,
    fallback: string,
    platformId: string,
    address: ConversationAddress
  ): void {
    const agentId = this.ctx.conversations.get(key)?.agentId ?? this.ctx.store?.boundAgent(key) ?? fallback;
    const def = findAgent(this.ctx.config, agentId);
    const adapter = this.ctx.platforms.get(platformId);
    const locale = localeOf(this.ctx.config);
    console.log(`[command] /help answered for ${key} (agent ${agentId})`);
    void adapter
      ?.sendMessage(address, buildHelpText(this.ctx.config, { agent: agentId, harness: def?.harness }, commandSurface(adapter), locale))
      .catch((e) => console.warn('[conversation] failed to send help:', e instanceof Error ? e.message : e));
  }

  /** Call off everything waiting on the user here — questions and voice transcripts alike. */
  private callOffPending(key: ConversationId, reason: string): void {
    this.ctx.hooks?.cancelPendingAsks?.(key, reason);
    this.ctx.hooks?.cancelPendingVoice?.(key, reason);
  }

  /**
   * Whether this message answers a question on screen. Not an attachment (the answer field is a
   * string) and not one of the gateway's own registered commands; a path like `/srv/data` still is.
   */
  private answersPendingQuestion(key: ConversationId, msg: InboundMessage): boolean {
    if ((msg.attachments?.length ?? 0) > 0) return false;
    const answer = msg.content.trim();
    if (answer.length === 0) return false;
    const command = parseTextCommand(answer);
    if (command && isGenericCommand(command.name)) return false;
    return this.ctx.hooks?.answerPendingAsk?.(key, answer) ?? false;
  }

  /** A topic with a session keeps its agent: refuse an explicit switch and hand over what the next agent needs. */
  private refuseAgentSwitch(
    key: ConversationId,
    choice: AgentChoice,
    address: ConversationAddress,
    msg: InboundMessage
  ): boolean {
    if (!choice.explicit) return false;
    const text = this.ctx.switchRefusal(key, choice.agentId);
    if (text === undefined) return false;
    void this.ctx.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(address, text)
      .catch((e) => console.warn('[conversation] failed to refuse an agent switch:', e instanceof Error ? e.message : e));
    return true;
  }

  /**
   * An agent command naming a harness nobody configured (`/agy` with no agy agent). Only reached when
   * resolveAgent declined the name: forwarded, the bound agent would read it as its own command and say nothing.
   */
  private reportUnconfiguredHarness(
    choice: AgentChoice,
    msg: InboundMessage,
    address: ConversationAddress
  ): boolean {
    if (choice.explicit) return false;
    const name = parseTextCommand(msg.content)?.name;
    const missing = name ? unconfiguredHarnessCommand(this.ctx.config, name) : undefined;
    if (!missing) return false;
    const locale = localeOf(this.ctx.config);
    console.log(`[command] /${name} names the unconfigured harness "${missing}"; not forwarded`);
    void this.ctx.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(
        address,
        tMenus(locale, 'unconfigured_harness', { missing })
      )
      .catch((e) => console.warn('[conversation] failed to report an unconfigured harness:', e instanceof Error ? e.message : e));
    return true;
  }

  /** `/agent` (who answers) and `/cd` (where it works): the gateway's own decisions. True when it was one. */
  private answerPlacementCommand(
    key: ConversationId,
    setting: { name: string; rest?: string },
    fallbackAgent: string,
    msg: InboundMessage,
    ack: (what: string, text: string) => void
  ): boolean {
    const name = setting.name.toLowerCase();
    if (AGENT_NAMES.has(name)) {
      const answer = this.applyAgentCommand(key, setting.rest, fallbackAgent, msg);
      if (answer.text !== undefined) ack('/agent', answer.text);
      // After the ack, so the menu lands under the line saying who it is for.
      if (answer.chosen) this.controls.offerPlacement(key, answer.chosen, msg.conversation);
      return true;
    }
    if (!WORKDIR_NAMES.has(name)) return false;
    const agentId = this.ctx.boundAgentFor(key, fallbackAgent);
    const answer = (): void => {
      const text = this.controls.applyWorkdirCommand(key, agentId, setting.rest, msg);
      if (text !== undefined) ack('/cd', text);
    };
    if (this.controls.isWorkdirLocked(key, agentId)) {
      answer();
      return true;
    }
    // An asked-for `/cd` on a remote agent lists what is there now, not what was there last time.
    const def = findAgent(this.ctx.config, agentId);
    if (def?.host) void this.controls.refreshRemoteScan(def).then(answer);
    else answer();
    return true;
  }

  /** `/agent`: the grouped menu, the list as text, or the agent named (`chosen`, even if the binding was refused). */
  private applyAgentCommand(
    key: ConversationId,
    rest: string | undefined,
    fallbackAgent: string,
    msg: InboundMessage
  ): { text?: string; chosen?: string } {
    const locale = localeOf(this.ctx.config);
    const groups = agentGroups(this.ctx.config.agents, this.ctx.hooks?.offlinePlaces?.());
    const current = this.ctx.boundAgentFor(key, fallbackAgent);
    const query = rest?.trim();
    if (!query) {
      const caps = this.ctx.platforms.get(msg.conversation.platform)?.capabilities;
      if (caps?.buttons && this.ctx.hooks?.onAgentMenuRequest && this.ctx.config.agents.length > 1) {
        this.ctx.hooks.onAgentMenuRequest(key, msg, { groups, current });
        return {};
      }
      return { text: agentListText(groups, current, locale) };
    }
    const match = matchAgent(this.ctx.config.agents, query);
    if (match.kind === 'none') return { text: tMenus(locale, 'agent_match_none', { query, list: agentListText(groups, current, locale) }) };
    if (match.kind === 'many') return { text: tMenus(locale, 'agent_match_many', { query, ids: match.ids.join(', ') }) };
    return { text: this.ctx.chooseAgent(key, match.def.id, msg.conversation), chosen: match.def.id };
  }

  // ───────────────────────────── `/setting` ─────────────────────────────

  /** `/setting`, `/setting <key>`, `/setting <key> <value>`; the typed value form works on every platform. */
  private handleSetting(
    key: ConversationId,
    rest: string,
    fallbackAgent: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): void {
    const platformId = msg.conversation.platform;
    const reply = (text: string): void => {
      void this.ctx.platforms
        .get(platformId)
        ?.sendMessage(address, text)
        .catch((e) => console.warn('[setting] failed to answer:', e instanceof Error ? e.message : e));
    };
    // NOT warmed, unlike `/model`: warming here would spawn a child to answer `/setting banana`.
    const ctx = this.settingsContext(key, fallbackAgent);
    const caps = this.ctx.platforms.get(platformId)?.capabilities;
    const canMenu =
      caps !== undefined &&
      settingsMenuSurface(caps) === 'menu' &&
      this.ctx.hooks?.onSettingMenuRequest !== undefined;

    const [rawKey = '', ...valueParts] = rest.trim().split(/\s+/);
    const msgLocale = (msg.locale ? normalizeLocale(msg.locale) : undefined) ?? localeOf(this.ctx.config);
    if (!rawKey) {
      console.log(`[setting] listing settings for ${key}`);
      if (canMenu) this.ctx.hooks!.onSettingMenuRequest!(key, msg, { rows: this.settingRows(msgLocale) });
      else reply([settingsListText(this.ctx.config, (id) => this.ctx.modelCatalog.modes(id)), this.ctx.hooks?.scheduleSummary?.()].filter(Boolean).join('\n'));
      return;
    }

    if (SCHEDULE_SETTING_NAMES.has(rawKey.toLowerCase())) {
      if (this.ctx.hooks?.onScheduleSetting) this.ctx.hooks.onScheduleSetting(key, msg, valueParts, canMenu);
      else reply('Scheduled tasks are not enabled in this gateway.');
      return;
    }

    const resolved = resolveSettingKey(rawKey, this.ctx.config, ctx);
    if (resolved.kind === 'refused') {
      console.log(`[setting] refused "${rawKey}" for ${key}`);
      reply(resolved.text);
      return;
    }
    if (resolved.kind === 'unknown') {
      reply(settingUnknownKeyText(rawKey));
      return;
    }

    const row = resolved.row;
    const value = valueParts.join(' ').trim();
    if (!value) {
      this.answerSettingKey(key, row, msg, canMenu, fallbackAgent, reply);
      return;
    }
    reply(settingAckText(this.applySetting(key, row, value)));
  }

  private answerSettingKey(
    key: ConversationId,
    row: SettingRow,
    msg: InboundMessage,
    canMenu: boolean,
    fallbackAgent: string,
    reply: (text: string) => void
  ): void {
    if (canMenu) {
      const { options, hint, asking } = this.settingOptionsFor(key, row);
      this.ctx.hooks!.onSettingMenuRequest!(key, msg, {
        rows: this.settingRows(),
        open: { row, options, ...(hint ? { hint } : {}) },
        ...(asking ? { asking } : {}),
      });
      return;
    }
    const detail = (): void => reply(settingDetailText(row, this.ctx.config, this.settingsContext(key, fallbackAgent)));
    // Text cannot be redrawn once sent, so it waits for the list (or the modes).
    const waits =
      row.target !== undefined &&
      ((row.id === 'model' && this.ctx.modelCatalog.shouldAsk(row.target)) ||
        (row.id === 'permissions' && this.ctx.modelCatalog.shouldAskModes(row.target)));
    if (waits && row.target) {
      void this.ctx.modelCatalog.ask(row.target).then(detail);
      return;
    }
    detail();
  }

  /** `peek`, never `getOrCreate`: a settings screen must not spawn an agent child to fill a menu. */
  private settingsContext(key: ConversationId, fallbackAgent: string): SettingsContext {
    const boundAgent =
      this.ctx.conversations.get(key)?.agentId ?? this.ctx.store?.boundAgent(key) ?? fallbackAgent;
    return {
      boundAgent,
      models: this.ctx.agents.peek(key)?.modelSelector?.()?.options ?? [],
      lists: (agentId) => this.ctx.modelCatalog.get(agentId),
      modes: (agentId) => this.ctx.modelCatalog.modes(agentId),
      pods: this.podModels(),
    };
  }

  /** A changed permission level moves every running session of that agent now; nothing is spawned. */
  private applyPermissionsLive(agentId: string): void {
    for (const [id, state] of this.ctx.conversations) {
      if (state.agentId !== agentId) continue;
      void this.ctx.agents.peek(id)?.applyPermissions?.();
      this.ctx.status.refresh(id);
    }
  }

  /** Read from the files each time: the merged Config holds only the answer, not whose value it is. */
  private podModels(): PodModels {
    try {
      return podAgentModels(readRawConfigIfExists() ?? {}, readPods(configDir()));
    } catch (e) {
      console.warn('[setting] could not read the pods\' agents:', e instanceof Error ? e.message : e);
      return new Map();
    }
  }

  settingRows(locale?: Locale): SettingRow[] {
    return settingsRows(this.ctx.config, this.podModels(), (id) => this.ctx.modelCatalog.modes(id), locale);
  }

  settingsBoundAgent(id: ConversationId): string {
    return this.settingsContext(id, this.ctx.config.routing.default).boundAgent;
  }

  /**
   * The values one row can offer now; a list not known yet starts being asked for (`asking`), from a
   * session of its own — never this conversation's, which would close a new topic's agent choice.
   */
  settingOptionsFor(
    id: ConversationId,
    row: SettingRow,
    ask = true,
    locale: Locale = localeOf(this.ctx.config)
  ): { options: SettingOption[]; hint?: string; asking?: Promise<unknown> } {
    let ctx = this.settingsContext(id, this.ctx.config.routing.default);
    let asking: Promise<unknown> | undefined;
    // The review model's list belongs to the reviewer, so the list screen and this agree.
    const listAgent = modelListAgent(row, this.ctx.config);
    const needs =
      listAgent === undefined
        ? false
        : row.id === 'permissions'
          ? this.ctx.modelCatalog.shouldAskModes(listAgent)
          : !(listAgent === ctx.boundAgent && ctx.models.length > 0) && this.ctx.modelCatalog.shouldAsk(listAgent);
    if (ask && listAgent && needs) {
      asking = this.ctx.modelCatalog.ask(listAgent);
      ctx = this.settingsContext(id, this.ctx.config.routing.default);
    }
    const hint = settingTypedOnlyHint(row, this.ctx.config, ctx);
    return { options: settingOptions(row, this.ctx.config, ctx, locale), ...(hint ? { hint } : {}), ...(asking ? { asking } : {}) };
  }

  modelListLoading(agentId: string): boolean {
    return this.ctx.modelCatalog.get(agentId)?.kind === 'loading';
  }

  applySetting(id: ConversationId, row: SettingRow, raw: string): SettingApplyResult {
    const state = this.ctx.conversations.get(id);
    // A `/model` override outranks agents[].model, so the ack says the new default does nothing here yet.
    const overridden =
      row.id === 'model' && row.target === state?.agentId && state?.modelOverride !== undefined;
    return this.settings.apply(
      row,
      raw,
      this.settingsContext(id, this.ctx.config.routing.default),
      overridden
    );
  }

  // ───────────────────────────── bare agent command ─────────────────────────────

  /**
   * A bare `/oc` (binding already applied): the directory menu for a conversation this agent never
   * ran in, else its command picker or a binding ack. "Never ran" is read off the STORE: an
   * idle-reclaimed conversation has no child but must not be asked for a directory again.
   */
  answerBare(
    key: ConversationId,
    state: ConversationState,
    platformId: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): void {
    const started = this.ctx.store?.agentSession(key, state.agentId) !== undefined;
    if (started) {
      this.answerBareNow(key, state, platformId, address, msg, false);
      return;
    }
    this.controls.afterRemoteListing(findAgent(this.ctx.config, state.agentId), () =>
      this.answerBareNow(key, state, platformId, address, msg, true)
    );
  }

  private answerBareNow(
    key: ConversationId,
    state: ConversationState,
    platformId: string,
    address: ConversationAddress,
    msg: InboundMessage,
    offerMenu: boolean
  ): void {
    if (offerMenu && this.controls.offerWorkdirMenu(key, state.agentId, msg.conversation)) return;

    const def = findAgent(this.ctx.config, state.agentId);
    if (harnessHasPicker(def?.harness) && this.ctx.hooks?.onPickerRequest) {
      this.ctx.hooks.onPickerRequest(key, state.agentId, msg);
      return;
    }
    const name = agentDisplayName(def, state.agentId);
    const locale = localeOf(this.ctx.config);
    void this.ctx.platforms
      .get(platformId)
      ?.sendMessage(address, tMenus(locale, 'agent_bound_ack', { name }))
      .catch((e) => console.warn('[route] failed to ack the binding:', e instanceof Error ? e.message : e));
  }

  // ───────────────────────────── generic command translation ─────────────────────────────

  /**
   * Rewrite a leading generic command into the bound harness's spelling, answer it here, or refuse
   * it. Returns the message to forward, or undefined when it was answered or refused (no turn runs).
   */
  translate(
    key: ConversationId,
    state: ConversationState,
    msg: InboundMessage,
    forward: (m: InboundMessage) => void
  ): InboundMessage | undefined {
    const parsed = parseTextCommand(msg.content);
    if (!parsed) return msg;
    const def = findAgent(this.ctx.config, state.agentId);
    const name = agentDisplayName(def, state.agentId);
    if (this.refusedForNesting(parsed.name, msg)) return undefined;

    if (this.deferredForCustom(key, state, def, parsed, msg, forward)) return undefined;
    const result = translateCommand(parsed.name, def?.harness, (opt) => this.declaresOption(key, state.agentId, opt) === true);
    if (this.answersWhileBusy(state, parsed.name, result)) {
      this.answerBusyQuery(key, state, parsed.name, msg);
      return undefined;
    }
    if (result.kind === 'passthrough') {
      // A name the harness's own CLI answers would, passed through, kill an agy session outright.
      if (isCliAnsweredCommand(parsed.name, def?.harness)) {
        void this.answerHarnessCliCommand(key, state, parsed.name, msg);
        return undefined;
      }
      return msg;
    }

    if (result.kind === 'local') {
      void this.answerLocalCommand(key, state, parsed.name, parsed.rest, msg);
      return undefined;
    }

    if (result.kind === 'unsupported') {
      this.refuseUnsupported(key, state, def, name, parsed.name, msg);
      return undefined;
    }

    if (result.native === parsed.name) return msg;
    const content = parsed.rest ? `/${result.native} ${parsed.rest}` : `/${result.native}`;
    console.log(`[command] /${parsed.name} → /${result.native} for ${state.agentId} (${name})`);
    return { ...msg, content };
  }

  /** No such command on this harness — unless it is `/usage` and the agent has its own quotaCommand. */
  private refuseUnsupported(
    key: ConversationId,
    state: ConversationState,
    def: AgentDef | undefined,
    name: string,
    command: string,
    msg: InboundMessage
  ): void {
    if (command === 'usage' && def?.quotaCommand) {
      void this.answerHarnessCliCommand(key, state, command, msg);
      return;
    }
    const locale = localeOf(this.ctx.config);
    // Point at the agent command (`/oc`), which is what the menu registers.
    const own = harnessCommandName(def?.harness);
    const hint = harnessHasPicker(def?.harness) && own
      ? tMenus(locale, 'cmd_unsupported_hint', { own })
      : '';
    this.reportUnsupported(msg, command, tMenus(locale, 'cmd_unsupported', { name, command, hint }));
    console.log(`[command] /${command} unsupported by ${state.agentId} (${name}); not forwarded`);
  }

  /** A /btw is answered by a reply to it, refusal included: the web UI's card waits for one. */
  private reportUnsupported(msg: InboundMessage, command: string, sorry: string): void {
    const platform = this.ctx.platforms.get(msg.conversation.platform);
    if (!platform) return;
    const address = addressOf(msg.conversation);
    const sent = command === 'btw'
      ? sendAside(platform, address, { address, messageId: msg.messageId }, sorry)
      : platform.sendMessage(address, sorry);
    sent.catch((e) => console.warn('[conversation] failed to report an unsupported command:', e instanceof Error ? e.message : e));
  }

  /** A custom harness that may have declared the option this command needs: find out first. */
  private deferredForCustom(
    key: ConversationId,
    state: ConversationState,
    def: AgentDef | undefined,
    parsed: { name: string; rest?: string },
    msg: InboundMessage,
    forward: (m: InboundMessage) => void
  ): boolean {
    const option = def && HARNESSES[def.harness].deferUnknownOptions ? customOptionFor(parsed.name) : undefined;
    if (!option || this.declaresOption(key, state.agentId, option) !== undefined) return false;
    void this.deferCustomCommand(key, state, parsed, msg, forward);
    return true;
  }

  /** Whether an agent declared an ACP config option; undefined when nothing has been seen yet. */
  private declaresOption(key: ConversationId, agentId: string, option: string): boolean | undefined {
    if (option !== 'model') return undefined;
    if (this.ctx.agents.peek(key)?.modelSelector?.()) return true;
    const known = this.ctx.modelCatalog.get(agentId);
    if (known?.kind === 'list') return true;
    if (known?.kind === 'none') return false;
    return undefined;
  }

  /**
   * Bring the session up (the child forwarding would start anyway) and let its report decide: answer
   * like a preset, or forward as before. The answer is kept so next time is decided at once.
   */
  private async deferCustomCommand(
    key: ConversationId,
    state: ConversationState,
    parsed: { name: string; rest?: string },
    msg: InboundMessage,
    forward: (m: InboundMessage) => void
  ): Promise<void> {
    const warm = await this.controls.warmModelSelector(key, state.agentId);
    if (warm.selector) {
      await this.answerLocalCommand(key, state, parsed.name, parsed.rest, msg);
      return;
    }
    if (!warm.error) this.ctx.modelCatalog.note(state.agentId, { kind: 'none' });
    console.log(
      `[command] /${parsed.name}: ${state.agentId} ${warm.error ? 'did not start' : 'declares no model option'}; forwarded as before`
    );
    forward(msg);
  }

  /** `/super` and the like need nested topics: refuse on a platform without them rather than spend a turn. */
  private refusedForNesting(command: string, msg: InboundMessage): boolean {
    const adapter = this.ctx.platforms.get(msg.conversation.platform);
    if (!adapter || !needsNestedTopics(command) || commandSurface(adapter).nested) return false;
    const locale = localeOf(this.ctx.config);
    void adapter
      .sendMessage(
        addressOf(msg.conversation),
        tMenus(locale, 'cmd_nested_unsupported', { command })
      )
      .catch((e) => console.warn('[conversation] failed to report an unsupported command:', e instanceof Error ? e.message : e));
    console.log(`[command] /${command} needs nested topics, which "${msg.conversation.platform}" has not; not forwarded`);
    return true;
  }

  /**
   * A session query that would be forwarded while the conversation is busy: it would wait behind the
   * running turn, or be glued into the collecting batch where the harness no longer sees a command.
   */
  private answersWhileBusy(state: ConversationState, name: string, result: CommandTranslation): boolean {
    if (result.kind === 'local' || result.kind === 'unsupported') return false;
    return isSessionQuery(name) && !state.merger.isIdle();
  }

  /** Answer from what the gateway holds, and say it is less than the harness's own answer. */
  private answerBusyQuery(
    key: ConversationId,
    state: ConversationState,
    name: string,
    msg: InboundMessage
  ): void {
    const command = name.toLowerCase();
    const label = agentDisplayName(findAgent(this.ctx.config, state.agentId), state.agentId);
    const since = state.merger.runningSince();
    const body =
      command === 'context'
        ? this.describeContext(state)
        : formatUsageSnapshot({
            agent: label,
            ...(state.lastUsage ? { usage: state.lastUsage } : {}),
            ...(state.lastCost ? { cost: state.lastCost } : {}),
            ...(since !== undefined ? { runningForMs: this.ctx.clock.now() - since } : {}),
          });
    console.log(`[command] /${command} answered by the gateway for ${key} (${state.agentId}): busy, not forwarded`);
    void this.ctx.platforms
      .get(msg.conversation.platform)
      ?.sendMessage(addressOf(msg.conversation), `${body}\n\n${busyNote(command, label)}`)
      .catch((e) =>
        console.warn('[command] failed to answer a busy query:', e instanceof Error ? e.message : e)
      );
  }

  /** A generic command the harness exposes over ACP rather than as text: answered here, never a turn. */
  private async answerLocalCommand(
    key: ConversationId,
    state: ConversationState,
    name: string,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<void> {
    const reply = (text: string): void => {
      void this.ctx.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), text)
        .catch((e) =>
          console.warn('[command] failed to answer locally:', e instanceof Error ? e.message : e)
        );
    };
    console.log(`[command] /${name} answered locally for ${key} (${state.agentId})`);
    try {
      if (name === 'context') return reply(this.describeContext(state));
      if (name === 'usage') return await this.answerHarnessCliCommand(key, state, name, msg);
      if (name === 'btw') return await this.answerSideQuestion(key, state, rest, msg);
      if (name === 'model') {
        // undefined: the answer went out as a menu.
        const text = await this.controls.applyModelCommand(state, key, rest, msg);
        if (text !== undefined) reply(text);
        return;
      }
      if (name === 'effort') {
        const text = await this.controls.applyEffortCommand(state, key, rest, msg);
        if (text !== undefined) reply(text);
        return;
      }
      reply(`/${name} has no local handler.`); // unreachable unless GENERIC_COMMANDS gains a `local` without one
    } catch (e) {
      reply(`Could not answer /${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * `/btw`: asked of a fork of the session (AgentSession.sideQuestion), so a running turn is neither
   * stopped nor queued behind and the context never sees it. Every reply goes out as a reply to the `/btw`.
   */
  private async answerSideQuestion(
    key: ConversationId,
    state: ConversationState,
    question: string | undefined,
    msg: InboundMessage
  ): Promise<void> {
    const platform = this.ctx.platforms.get(msg.conversation.platform);
    if (!platform) return;
    const address = addressOf(msg.conversation);
    const asked: MessageRef = { address, messageId: msg.messageId };
    const say = (text: string): void => {
      sendAside(platform, address, asked, text).catch((e) =>
        console.warn('[btw] failed to reply:', e instanceof Error ? e.message : e)
      );
    };
    const locale = localeOf(this.ctx.config);
    const text = question?.trim();
    if (!text) {
      say(tMenus(locale, 'cmd_btw_usage'));
      return;
    }
    // A side question that dropped its pictures would answer about something it never saw.
    if ((msg.attachments?.length ?? 0) > 0) {
      say(tMenus(locale, 'cmd_btw_words_only'));
      return;
    }
    const session = this.ctx.agents.getOrCreate(key, state.agentId);
    if (!session.sideQuestion) {
      say(tMenus(locale, 'cmd_btw_unsupported', { name: agentDisplayName(findAgent(this.ctx.config, state.agentId), state.agentId) }));
      return;
    }
    const render = this.turns.runner.beginAside(key, platform, address, text, asked);
    try {
      const outcome = await session.sideQuestion({ prompt: text, sessionToken: this.ctx.tokens.tokenFor(key) }, render.handlers);
      await render.finish(outcome === 'stopped' ? 'stopped' : undefined);
      console.log(`[btw] ${key} (${state.agentId}): side question ${outcome}`);
    } catch (e) {
      if (e instanceof SideQuestionRefused) {
        console.log(`[btw] ${key} (${state.agentId}): refused — ${e.message}`);
        say(e.message);
        return;
      }
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`[btw] ${key} (${state.agentId}): failed — ${why}`);
      await render.finish(`failed: ${why}`);
    }
  }

  /**
   * A command the harness's own CLI owns, run as a one-shot process (agy's, or an agent's
   * quotaCommand for `/usage`). Arguments are dropped: user text never reaches a subprocess argv.
   */
  private async answerHarnessCliCommand(
    key: ConversationId,
    state: ConversationState,
    name: string,
    msg: InboundMessage
  ): Promise<void> {
    const def = findAgent(this.ctx.config, state.agentId);
    const label = agentDisplayName(def, state.agentId);
    const locale = localeOf(this.ctx.config);
    const reply = (text: string): void => {
      void this.ctx.platforms
        .get(msg.conversation.platform)
        ?.sendMessage(addressOf(msg.conversation), text)
        .catch((e) =>
          console.warn('[command] failed to deliver a harness CLI answer:', e instanceof Error ? e.message : e)
        );
    };
    const own = name === 'usage' && def?.quotaCommand !== undefined;
    if (!def || (!own && !HARNESSES[def.harness].hasBuiltinCli)) {
      reply(tMenus(locale, 'cmd_harness_cli_outside', { label, name }));
      return;
    }
    const cwd = resolveConversationCwd(def, key, this.ctx.store);
    console.log(`[command] /${name} run as ${own ? 'the agent\'s quotaCommand' : 'a one-shot agy process'} for ${key} (${state.agentId})`);
    const result = own ? await runQuotaCommandFor(def, cwd) : await runAgyCliFor(def, name, cwd, this.ctx.runHarnessCli);
    if (!result.ok) {
      reply(tMenus(locale, 'cmd_harness_cli_failed', { label, name, error: result.error }));
      return;
    }
    reply(formatAgyCliOutput(name, result.output));
  }

  /**
   * `/context`, rendered as the footer renders it. The two empty answers differ on purpose: before
   * the first turn the numbers are late; after one they are not coming (opencode 1.18.27: a model
   * without a known window sends no usage at all), so the second names the fix.
   */
  private describeContext(state: ConversationState): string {
    const def = findAgent(this.ctx.config, state.agentId);
    const name = agentDisplayName(def, state.agentId);
    const locale = localeOf(this.ctx.config);
    const usage = state.lastUsage;
    if (!usage) {
      if (!state.turnCompleted) {
        return tMenus(locale, 'cmd_context_no_numbers');
      }
      const fix = def ? (HARNESSES[def.harness].contextMissingHint ?? '') : '';
      return tMenus(locale, 'cmd_context_not_reported', { name, fix });
    }
    const line = formatRuntimeFooter(
      { contextTokens: usage.used, contextLength: usage.size },
      ['context']
    );
    const left = Math.max(0, usage.size - usage.used);
    return `Context: ${line}\n${tMenus(locale, 'cmd_context_left', { tokens: formatTokens(left), name })}`;
  }
}
