import type { AgentDef } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
import { localeOf } from '../core/i18n/index.js';
import { tMenus } from '../core/i18n/menus.js';
import { addressOf, type ConversationAddress, type ConversationRef } from '../core/conversation.js';
import {
  effortAmbiguousText,
  effortChoiceText,
  effortMenuSurface,
  effortNoMatchText,
  effortNoSelectorText,
  effortStartFailedText,
  effortSummaryText,
  matchEfforts,
  type EffortChoiceResult,
} from '../core/effort-menu.js';
import { rankByFrecency } from '../core/frecency.js';
import { formatLaneTitle, subjectOf } from '../core/lane-title.js';
import {
  matchModels,
  modelAmbiguousText,
  modelChoiceText,
  modelMenuSurface,
  modelNoMatchText,
  modelNoSelectorText,
  modelStartFailedText,
  modelSummaryText,
  type ModelChoiceResult,
} from '../core/model-menu.js';
import { shortModelName } from '../core/runtime-footer.js';
import { offeredLevelsFor, unsetLevel } from '../core/permission-levels.js';
import { fallbackTitle, generateTitle } from '../core/title-namer.js';
import {
  matchWorkdirs,
  workdirAmbiguousText,
  workdirChoiceText,
  workdirMenuSurface,
  workdirNoMatchText,
  workdirSummaryText,
  workdirUnreadableText,
  type WorkdirChoiceResult,
} from '../core/workdir-menu.js';
import {
  EFFORT_OPTION_ID,
  type ModelPickerList,
  type ModelPickerResult,
  type SessionOptionList,
  type SessionOptionPeek,
  type SessionOptionResult,
  type TopicTree,
} from '../platform/workbench.js';
import type {
  ConversationId,
  EffortSelector,
  InboundMessage,
  ModelSelector,
  SessionOption,
  StatusOption,
  StatusPermissions,
} from '../types.js';
import { forkRefusal } from './acp-fork.js';
import { NO_FORK } from './acp-side-question.js';
import { ForkRefused, type AgentSession } from './agent.js';
import { resolveAgentCwd } from './agent-common.js';
import type { ConversationContext, ConversationState } from './conversation-context.js';
import type { ConversationHistory } from './conversation-history.js';
import { remoteHosts } from './remote-hosts.js';
import { resolveAgent, routeInputFromRef } from './routing.js';
import { statusOptions } from './status-board.js';
import { isDirectory, scanWorkdirs, workdirScanFrom, type WorkdirScan } from './workdir-scan.js';

/** How long a menu offered on the side (a bare `/cc`, `/new`) waits for a remote root's first listing. */
export const REMOTE_LISTING_WAIT_MS = 5_000;
/** How long a cached remote directory listing stays fresh before a background refresh is triggered. */
export const REMOTE_SCAN_TTL_MS = 30_000;
const MAX_REMOTE_SCANS = 200;

type RemoteListingEntry = { readonly name: string; readonly dir: boolean };
type RemoteListingCache =
  | { readonly ok: true; readonly entries: readonly RemoteListingEntry[]; readonly at: number }
  | { readonly ok: false; readonly reason: string; readonly at: number };

/**
 * The per-conversation controls: `/model`, `/effort`, `/cd`, `/fork`, `/title`, and the web UI's
 * model and option switches. Each typed path and its clicked twin share one setter, so they cannot
 * answer differently; setters return failures as values because a click has nobody to re-prompt.
 */
export class ConversationControls {
  /** Naming calls in flight: the store gate cannot cover the seconds before the platform accepts a rename. */
  private readonly namingInFlight = new Set<ConversationId>();
  /** Cached remote directory listings keyed by `<host>\0<dir>` (shared across agents on the same host). */
  private readonly remoteScans = new Map<string, RemoteListingCache>();
  /** Coalesces concurrent remote `listDir` RPCs for the same `<host>\0<dir>`. */
  private readonly remoteScansInFlight = new Map<string, Promise<RemoteListingCache>>();

  constructor(
    private readonly ctx: ConversationContext,
    private readonly history: ConversationHistory
  ) {}

  // ───────────────────────── conversation title (thread/topic rename) ─────────────────────────

  /** `/title` — report, set, or (`auto`) release the recorded name; never silently skipped. */
  async applyTitleCommand(
    key: ConversationId,
    fallbackAgent: string,
    rest: string,
    address: ConversationAddress,
    msg: InboundMessage
  ): Promise<string> {
    const wanted = rest.trim();
    const platformId = msg.conversation.platform;
    const current = this.ctx.store?.conversationTitle(key);
    const locale = localeOf(this.ctx.config);

    if (wanted.toLowerCase() === 'auto') {
      if (!current) {
        return tMenus(locale, 'title_not_named_yet');
      }
      this.ctx.store?.releaseConversationTitle(key);
      return tMenus(locale, 'title_released', { current });
    }

    if (!wanted) {
      if (!current) {
        return tMenus(locale, 'title_not_named_prompt');
      }
      return this.ctx.store?.titlePinned(key)
        ? tMenus(locale, 'title_pinned_status', { current })
        : tMenus(locale, 'title_auto_status', { current });
    }

    const agentId = this.ctx.boundAgentFor(key, fallbackAgent);
    const failure = await this.retitleLane(
      key,
      agentId,
      address,
      platformId,
      formatLaneTitle(agentId, wanted),
      true
    );
    if (failure) return tMenus(locale, 'title_failed', { failure });
    return tMenus(locale, 'title_success', { wanted });
  }

  /**
   * Name this conversation's lane after its opening message — once, beside the turn rather than
   * after it. Called at every turn start; every early return is a decision (see the module README).
   */
  nameConversation(id: ConversationId, seed: string): void {
    try {
      const lane = this.ctx.laneOf(id);
      if (!this.ctx.conversations.has(id) || !lane || !seed.trim()) return;
      if (this.ctx.config.platforms[lane.platformId]?.autoRenameThread === false) return;
      // Ask whether the rename could land BEFORE paying a model call for the name.
      if (!this.canRetitle(lane.platformId, lane.address)) return;
      if (this.ctx.store?.conversationTitle(id) !== undefined) return;
      if (this.namingInFlight.has(id)) return;
      this.namingInFlight.add(id);
      void (async () => {
        try {
          const subject = await this.summarizeTitle(seed);
          if (!subject) return;
          // Re-read: a `/title` or `/oc` may have landed while the model was thinking.
          if (this.ctx.store?.conversationTitle(id) !== undefined) return;
          const state = this.ctx.conversations.get(id);
          const target = this.ctx.laneOf(id);
          if (!state || !target) return;
          await this.retitleLane(
            id,
            state.agentId,
            target.address,
            target.platformId,
            formatLaneTitle(state.agentId, subject)
          );
        } finally {
          this.namingInFlight.delete(id);
        }
      })();
    } catch (e) {
      // Runs on the turn's own thread: a throw here must not cost the user their answer.
      console.warn(`[title] could not start naming ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Falls back on failure: an unnamed conversation would re-run the call on every turn. */
  private async summarizeTitle(seed: string): Promise<string> {
    const llm = this.ctx.config.title.llm;
    if (!llm) return fallbackTitle(seed);
    return (await generateTitle(llm, seed)) ?? fallbackTitle(seed);
  }

  private canRetitle(platformId: string, address: ConversationAddress): boolean {
    // The declaration, not `renameThread`: that member is required and throws when unsupported.
    return Boolean(this.ctx.platforms.get(platformId)?.capabilities.renameThread && address.thread);
  }

  /** Rename a lane and record it; returns why not (which `/title` reports), undefined on success. */
  private async retitleLane(
    id: ConversationId,
    agentId: string,
    address: ConversationAddress,
    platformId: string,
    title: string,
    pinned = false
  ): Promise<string | undefined> {
    const locale = localeOf(this.ctx.config);
    const platform = this.ctx.platforms.get(platformId);
    if (!platform?.capabilities.renameThread || !platform.renameThread) {
      return tMenus(locale, 'title_err_platform');
    }
    if (!address.thread) {
      return tMenus(locale, 'title_err_no_thread');
    }
    const wanted = title.trim();
    if (!wanted) return tMenus(locale, 'title_err_empty');
    try {
      await platform.renameThread(address, wanted);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[title] could not rename ${id} to "${wanted}": ${reason}`);
      return reason;
    }
    // Recorded only after the platform accepted it, so a failed rename is retried next turn.
    this.ctx.store?.setConversationTitle(id, agentId, wanted, pinned);
    this.ctx.history?.setTitle(id, wanted);
    console.log(`[title] ${id} renamed to "${wanted}"${pinned ? ' (pinned)' : ''}`);
    return undefined;
  }

  // ───────────────────────────── `/fork` ─────────────────────────────

  /**
   * `/fork`: copy this conversation into a new web UI topic beside it. Only a person reaches this (a
   * daemon command): an agent-reachable fork would be a sub-agent without Security invariant 6's card.
   */
  async forkAndReport(
    key: ConversationId,
    msg: InboundMessage,
    address: ConversationAddress,
    fallbackAgent: string
  ): Promise<string> {
    const locale = localeOf(this.ctx.config);
    const platformId = msg.conversation.platform;
    const adapter = this.ctx.platforms.get(platformId);
    const forkThread = adapter?.topics?.forkThread;
    if (!forkThread) return tMenus(locale, 'fork_web_only');
    const agentId = this.ctx.boundAgentFor(key, fallbackAgent);
    const label = agentDisplayName(findAgent(this.ctx.config, agentId), agentId);
    if (!this.ctx.store?.agentSession(key, agentId)) {
      return tMenus(locale, 'fork_nothing_yet', { label });
    }
    const session = this.ctx.agents.getOrCreate(key, agentId);
    if (!session.forkFrom) return tMenus(locale, 'fork_unsupported', { label });
    const asked = await this.forkReady(key, session, label, agentId);
    if (asked) return asked;
    // Read again: a source whose stored session could not be reloaded just now has a fresh one.
    const sourceId = this.ctx.store?.agentSession(key, agentId);
    if (!sourceId) return tMenus(locale, 'fork_nothing_yet', { label });
    return this.makeFork({ key, address, platformId, forkThread, agentId, label, sourceId });
  }

  private async makeFork(f: {
    key: ConversationId;
    address: ConversationAddress;
    platformId: string;
    forkThread: TopicTree['forkThread'];
    agentId: string;
    label: string;
    sourceId: string;
  }): Promise<string> {
    const { key, address, platformId, forkThread, agentId, label, sourceId } = f;
    const locale = localeOf(this.ctx.config);
    const turn = this.history.lastTurnOf(key);
    let opened: Awaited<ReturnType<typeof forkThread>>;
    try {
      opened = await forkThread(address, turn !== undefined ? { turn } : {});
    } catch (e) {
      return tMenus(locale, 'fork_failed', { reason: e instanceof Error ? e.message : String(e) });
    }
    const conv = this.ctx.conversationAt(platformId, opened.address);
    if (!conv) {
      opened.discard();
      return tMenus(locale, 'fork_no_scope');
    }
    this.seedFork(key, conv.key, platformId, agentId);
    this.ctx.platforms.get(platformId)?.workbench?.refreshWorkdir(opened.address);
    try {
      const fork = this.ctx.agents.getOrCreate(conv.key, agentId);
      if (!fork.forkFrom) throw new Error(`${label} cannot start a session as a copy`);
      await fork.forkFrom({ sessionId: sourceId, sessionToken: this.ctx.tokens.tokenFor(conv.key) });
    } catch (e) {
      // Nothing of the copy exists, so neither should a topic that says it is one.
      this.ctx.agents.dispose(conv.key);
      this.ctx.releaseState(conv.key);
      this.ctx.store?.clear(conv.key);
      opened.discard();
      console.warn(`[fork] ${key} (${agentId}): ${e instanceof Error ? e.message : e}`);
      return e instanceof ForkRefused ? e.message : tMenus(locale, 'fork_failed', { reason: e instanceof Error ? e.message : String(e) });
    }
    console.log(`[fork] ${key} (${agentId}) → ${conv.key} at turn ${turn ?? '?'}`);
    this.warnIfForkRaced(key, turn, platformId, opened.address, label);
    const link = opened.address.thread ? `[${subjectOf(opened.title)}](?t=${opened.address.thread})` : `"${opened.title}"`;
    const at = turn !== undefined ? tMenus(locale, 'fork_at_turn', { turn }) : '';
    return tMenus(locale, 'fork_success', { link, at });
  }

  /**
   * The refusal while a turn or background work runs, or the agent declares no fork. Whether it can
   * fork is only said in `initialize`, so a cold conversation is started first, then asked again.
   */
  private async forkReady(key: ConversationId, session: AgentSession, label: string, agentId: string): Promise<string | undefined> {
    const locale = localeOf(this.ctx.config);
    const busy = (): string | undefined => {
      if (this.ctx.isBusy(key)) return tMenus(locale, 'fork_busy_turn', { label });
      if (session.backgroundActive?.()) return tMenus(locale, 'fork_busy_background', { label });
      return undefined;
    };
    const now = busy();
    if (now) return now;
    try {
      if (session.canFork?.() === undefined) await session.ensureSession?.(this.ctx.tokens.tokenFor(key));
    } catch (e) {
      return tMenus(locale, 'fork_failed', { reason: e instanceof Error ? e.message : String(e) });
    }
    if (session.canFork?.() === false) return forkRefusal(agentId, NO_FORK);
    return busy();
  }

  /** Set the fork up as its source is, before its session exists: the runtime reads cwd/model/effort off the record. */
  private seedFork(sourceKey: ConversationId, forkKey: ConversationId, platformId: string, agentId: string): void {
    const state = this.ctx.ensureState(forkKey, platformId, agentId, { fresh: true, opener: `/fork of ${sourceKey}` });
    const store = this.ctx.store;
    if (!store) return;
    const cwd = store.conversationCwd(sourceKey);
    if (cwd) store.setConversationCwd(forkKey, agentId, cwd);
    for (const which of ['model', 'effort'] as const) {
      const value = store.conversationChoice?.(sourceKey, agentId, which);
      if (value) store.setConversationChoice?.(forkKey, agentId, which, value);
    }
    // ensureState read the record before the choice was copied into it.
    const model = store.conversationChoice?.(forkKey, agentId, 'model');
    if (model) state.modelOverride = model;
  }

  private warnIfForkRaced(
    sourceKey: ConversationId,
    turn: number | undefined,
    platformId: string,
    forkAddress: ConversationAddress,
    label: string
  ): void {
    if (!this.ctx.isBusy(sourceKey) && this.history.lastTurnOf(sourceKey) === turn) return;
    console.warn(`[fork] ${sourceKey}: a turn started while the copy was being made`);
    const locale = localeOf(this.ctx.config);
    void this.ctx.platforms
      .get(platformId)
      ?.sendMessage(
        forkAddress,
        tMenus(locale, 'fork_warn_raced', { label })
      )
      .catch((e) => console.warn('[fork] could not say the copy raced a turn:', e instanceof Error ? e.message : e));
  }

  // ───────────────────────────── model (`/model`) ─────────────────────────────

  /** The one answer to "what models can this conversation choose from", starting the session if need be. */
  async warmModelSelector(
    key: ConversationId,
    agentId: string
  ): Promise<{ session: AgentSession; selector?: ModelSelector; error?: string }> {
    return this.warmSelector(key, agentId, (s) => s.modelSelector?.());
  }

  /** Read a selector off the live session, bringing the session up first when it has none yet. */
  async warmSelector<T>(
    key: ConversationId,
    agentId: string,
    read: (session: AgentSession) => T | undefined
  ): Promise<{ session: AgentSession; selector?: T; error?: string }> {
    const session = this.ctx.agents.getOrCreate(key, agentId);
    const known = read(session);
    if (known) return { session, selector: known };
    if (!session.ensureSession) return { session };
    try {
      await session.ensureSession(this.ctx.tokens.tokenFor(key));
    } catch (e) {
      return { session, error: e instanceof Error ? e.message : String(e) };
    }
    return { session, selector: read(session) };
  }

  /** `/model`: the menu, the summary, or a switch by id or substring; undefined when a menu went out. */
  async applyModelCommand(
    state: ConversationState,
    key: ConversationId,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<string | undefined> {
    const locale = localeOf(this.ctx.config);
    const typing = this.ctx.platforms.get(msg.conversation.platform);
    void typing?.startTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    const warm = await this.warmModelSelector(key, state.agentId);
    void typing?.stopTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    if (warm.error) return modelStartFailedText(warm.error, locale);
    const selector = warm.selector;
    if (!selector) return modelNoSelectorText(locale);

    const query = rest?.trim();
    if (!query) {
      const caps = this.ctx.platforms.get(msg.conversation.platform)?.capabilities;
      if (
        caps &&
        modelMenuSurface(caps, selector.options.length) === 'menu' &&
        this.ctx.hooks?.onModelMenuRequest
      ) {
        this.ctx.hooks.onModelMenuRequest(key, state.agentId, msg, selector);
        return undefined;
      }
      return modelSummaryText(selector, locale);
    }

    const match = matchModels(selector.options, query);
    if (match.kind === 'none') return modelNoMatchText(query, locale);
    if (match.kind === 'many') return modelAmbiguousText(query, match.matches, locale);
    return modelChoiceText(await this.setModelOn(warm.session, state, match.option.value), locale);
  }

  private async setModelOn(
    session: AgentSession,
    state: ConversationState,
    value: string
  ): Promise<ModelChoiceResult> {
    if (!session.setModel) {
      return { kind: 'failed', reason: 'this agent cannot switch models at runtime' };
    }
    try {
      const applied = await session.setModel(value);
      state.modelOverride = applied;
      // The levels belong to the model: the new one may offer others, or none.
      this.ctx.status.effort(session.conversationId, session.effortSelector?.()?.current);
      // Only a person's paths reach here (applyScheduledModel sets the field directly).
      this.ctx.hooks?.onModelSet?.(session.conversationId);
      // The value as offered, not `applied`: that can be a display name the selector would not take back.
      this.ctx.store?.setConversationChoice?.(session.conversationId, state.agentId, 'model', value);
      return { kind: 'applied', model: applied };
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A clicked model. A menu is a snapshot: re-check the binding, and above all that the value is still offered. */
  async applyModelChoice(
    id: ConversationId,
    expectAgentId: string,
    value: string
  ): Promise<ModelChoiceResult> {
    const state = this.ctx.conversations.get(id);
    if (!state) return { kind: 'gone' };
    if (state.agentId !== expectAgentId) {
      const def = findAgent(this.ctx.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    const warm = await this.warmModelSelector(id, state.agentId);
    const selector = warm.selector;
    if (!selector) return { kind: 'unavailable' };
    if (!selector.options.some((o) => o.value === value)) return { kind: 'missing', value };
    return this.setModelOn(warm.session, state, value);
  }

  // ───────────────────────────── reasoning effort (`/effort`) ─────────────────────────────

  /** `/effort`, in `/model`'s three shapes; "no levels" names the model, since levels vary per model. */
  async applyEffortCommand(
    state: ConversationState,
    key: ConversationId,
    rest: string | undefined,
    msg: InboundMessage
  ): Promise<string | undefined> {
    const locale = localeOf(this.ctx.config);
    const typing = this.ctx.platforms.get(msg.conversation.platform);
    void typing?.startTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    const warm = await this.warmSelector(key, state.agentId, (s) => s.effortSelector?.());
    void typing?.stopTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    if (warm.error) return effortStartFailedText(warm.error, locale);
    const selector = warm.selector;
    if (!selector) {
      const def = findAgent(this.ctx.config, state.agentId);
      return effortNoSelectorText(def?.harness, warm.session.modelSelector?.()?.current, locale);
    }

    const query = rest?.trim();
    if (!query) return this.answerBareEffort(state, key, msg, selector);

    const match = matchEfforts(selector.options, query);
    if (match.kind === 'none') return effortNoMatchText(query, selector.options, locale);
    if (match.kind === 'many') return effortAmbiguousText(query, match.matches, locale);
    return effortChoiceText(await this.setEffortOn(warm.session, state.agentId, match.option.value), locale);
  }

  private answerBareEffort(
    state: ConversationState,
    key: ConversationId,
    msg: InboundMessage,
    selector: EffortSelector
  ): string | undefined {
    const caps = this.ctx.platforms.get(msg.conversation.platform)?.capabilities;
    if (
      caps &&
      effortMenuSurface(caps, selector.options.length) === 'menu' &&
      this.ctx.hooks?.onEffortMenuRequest
    ) {
      this.ctx.hooks.onEffortMenuRequest(key, state.agentId, msg, selector);
      return undefined;
    }
    const locale = localeOf(this.ctx.config);
    return effortSummaryText(selector, locale);
  }

  private async setEffortOn(session: AgentSession, agentId: string, value: string): Promise<EffortChoiceResult> {
    if (!session.setEffort) {
      return { kind: 'failed', reason: 'this agent cannot switch effort at runtime' };
    }
    try {
      const effort = await session.setEffort(value);
      this.ctx.store?.setConversationChoice?.(session.conversationId, agentId, 'effort', value);
      this.ctx.status.effort(session.conversationId, effort);
      return { kind: 'applied', effort };
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A clicked level; a `/model` in between can reshape the whole list, so a stale level is normal. */
  async applyEffortChoice(
    id: ConversationId,
    expectAgentId: string,
    value: string
  ): Promise<EffortChoiceResult> {
    const state = this.ctx.conversations.get(id);
    if (!state) return { kind: 'gone' };
    if (state.agentId !== expectAgentId) {
      const def = findAgent(this.ctx.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    const warm = await this.warmSelector(id, state.agentId, (s) => s.effortSelector?.());
    const selector = warm.selector;
    if (!selector) return { kind: 'unavailable' };
    if (!selector.options.some((o) => o.value === value)) return { kind: 'missing', value };
    return this.setEffortOn(warm.session, state.agentId, value);
  }

  // ───────────────────────────── web UI model and option switches ─────────────────────────────

  /** The model list for an ADDRESS (`useModelPicker`): warmed like `/model`, bound as a first message would bind. */
  async modelPickerForRef(ref: ConversationRef): Promise<ModelPickerList> {
    const locale = localeOf(this.ctx.config);
    const id = this.ctx.idForRef(ref);
    const agentId =
      this.ctx.conversations.get(id)?.agentId ?? this.ctx.boundAgentFor(id, resolveAgent(this.ctx.config, routeInputFromRef(ref)).agentId);
    const state = this.ctx.ensureState(id, ref.platform, agentId, { opener: 'the model switch' });
    const warm = await this.warmModelSelector(id, state.agentId);
    if (warm.error) return { ok: false, agent: state.agentId, reason: 'error', text: modelStartFailedText(warm.error, locale) };
    if (!warm.selector || warm.selector.options.length === 0) {
      return { ok: false, agent: state.agentId, reason: 'none', text: modelNoSelectorText(locale) };
    }
    const liveModel = selectorModelLabel(warm.selector);
    if (liveModel) this.ctx.status.model(id, liveModel);
    const liveOpts = warm.session.sessionOptions?.();
    if (liveOpts?.length) this.ctx.status.options(id, liveOpts);
    this.ctx.status.effort(id, warm.session.effortSelector?.()?.current);
    const configured = findAgent(this.ctx.config, state.agentId)?.model;
    return {
      ok: true,
      agent: state.agentId,
      ...(warm.selector.current ? { current: warm.selector.current } : {}),
      ...(configured ? { configured } : {}),
      ...(state.modelOverride ? { override: state.modelOverride } : {}),
      options: warm.selector.options.map((o) => ({ value: o.value, name: o.name })),
    };
  }

  async chooseModelForRef(ref: ConversationRef, value: string): Promise<ModelPickerResult> {
    const locale = localeOf(this.ctx.config);
    const id = this.ctx.idForRef(ref);
    const state = this.ctx.conversations.get(id);
    const result = state ? await this.applyModelChoice(id, state.agentId, value) : ({ kind: 'gone' } as const);
    const text = modelChoiceText(result, locale);
    if (result.kind !== 'applied') return { ok: false, text };
    this.ctx.status.model(id, result.model);
    console.log(`[model] ${id}: switched to ${result.model} from the model switch`);
    return { ok: true, model: result.model, text };
  }

  /**
   * The agent's own settings for an ADDRESS without starting its agent. A conversation with no
   * session yet may make the catalog start a throwaway session once per run: before the first
   * message is when such a setting can still change.
   */
  async optionStatusForRef(ref: ConversationRef): Promise<SessionOptionPeek> {
    const id = this.ctx.idForRef(ref);
    const agent = this.agentForRef(id, ref);
    const live = this.ctx.agents.peek(id);
    const own = live?.sessionOptions?.();
    const permissions = this.permissionsForAgent(agent);
    if (own) {
      const model = this.peekModelFor(id, agent, live, false);
      const effort = live?.effortSelector?.()?.current;
      return {
        agent,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        options: statusOptions(own),
        ...(permissions ? { permissions } : {}),
      };
    }
    const fresh = this.ctx.store?.agentSession(id, agent) === undefined;
    const kinds = fresh ? await this.ctx.modelCatalog.learnOptions(agent) : (this.ctx.modelCatalog.options(agent) ?? []);
    const model = this.peekModelFor(id, agent, live, fresh);
    const effort = await this.peekEffortFor(id, agent, fresh);
    return {
      agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      options: kinds.map((k) => peekOptionStatus(k, fresh)),
      ...(permissions ? { permissions } : {}),
    };
  }

  /**
   * The level a conversation with no live session would be on, as far as known without starting it:
   * its own `/effort`, a pin in `agents[].options`, or — new, on the configured model — a fresh
   * session's. Undefined when none of those is known: a guessed level would be read as the real one.
   */
  private async peekEffortFor(id: ConversationId, agent: string, fresh: boolean): Promise<string | undefined> {
    const chosen = this.ctx.store?.conversationChoice?.(id, agent, 'effort');
    if (chosen) return chosen;
    const ownModel = this.ctx.conversations.get(id)?.modelOverride ?? this.ctx.store?.conversationChoice?.(id, agent, 'model');
    const known = fresh && !ownModel ? await this.ctx.modelCatalog.learnEffort(agent) : this.ctx.modelCatalog.effort(agent);
    if (!known) return undefined;
    const pinned = known.id !== undefined ? findAgent(this.ctx.config, agent)?.options[known.id] : undefined;
    if (pinned !== undefined) return String(pinned);
    return fresh && !ownModel ? known.current : undefined;
  }

  permissionsForAgent(agentId: string): StatusPermissions | undefined {
    const def = findAgent(this.ctx.config, agentId);
    if (!def) return undefined;
    const modes = this.ctx.modelCatalog.modes(agentId);
    const modeIds = modes?.kind === 'list' ? modes.options.map((o) => o.value) : [];
    const liveMode = modes?.kind === 'list' ? modes.current : undefined;
    const unset = def.permissions === undefined;
    const level = def.permissions ?? unsetLevel(def, liveMode).level;
    return {
      level,
      ...(unset ? { unset: true } : {}),
      offered: offeredLevelsFor(def, modeIds),
    };
  }

  private peekModelFor(id: ConversationId, agent: string, live: AgentSession | undefined, fresh: boolean): string | undefined {
    const raw =
      selectorModelLabel(live?.modelSelector?.()) ??
      this.ctx.conversations.get(id)?.modelOverride ??
      findAgent(this.ctx.config, agent)?.model ??
      (fresh ? this.ctx.modelCatalog.defaultModel(agent) : undefined);
    return raw ? shortModelName(raw) : undefined;
  }

  async optionsForRef(ref: ConversationRef): Promise<SessionOptionList> {
    const locale = localeOf(this.ctx.config);
    const id = this.ctx.idForRef(ref);
    const state = this.ctx.ensureState(id, ref.platform, this.agentForRef(id, ref), { opener: 'a setting switch' });
    const agent = state.agentId;
    const warm = await this.warmSelector(id, agent, (s) => nonEmpty(s.sessionOptions?.()));
    const permissions = this.permissionsForAgent(agent);
    if (warm.error) {
      return { ok: false, agent, reason: 'error', text: tMenus(locale, 'opt_start_failed', { agent, error: warm.error }), ...(permissions ? { permissions } : {}) };
    }
    const effort = warm.session.effortSelector?.();
    this.ctx.status.effort(id, effort?.current);
    const extra = { ...(permissions ? { permissions } : {}), ...(effort ? { effort } : {}) };
    if (!warm.selector) {
      return { ok: false, agent, reason: 'none', text: tMenus(locale, 'opt_none_to_change', { agent }), ...extra };
    }
    const liveModel = selectorModelLabel(warm.session.modelSelector?.());
    if (liveModel) this.ctx.status.model(id, liveModel);
    this.ctx.status.options(id, warm.selector);
    return { ok: true, agent, options: warm.selector, ...extra };
  }

  /** Set one of the agent's own settings; the agent may still refuse a listed value, in its own words. */
  async chooseOptionForRef(ref: ConversationRef, optionId: string, value: string): Promise<SessionOptionResult> {
    const locale = localeOf(this.ctx.config);
    const id = this.ctx.idForRef(ref);
    const state = this.ctx.conversations.get(id);
    if (optionId === EFFORT_OPTION_ID) return this.chooseEffortFor(id, state, value);
    if (!state) return { ok: false, text: tMenus(locale, 'opt_conv_gone') };
    const warm = await this.warmSelector(id, state.agentId, (s) => nonEmpty(s.sessionOptions?.()));
    if (warm.error) return { ok: false, text: tMenus(locale, 'opt_start_failed', { agent: state.agentId, error: warm.error }) };
    const option = warm.selector?.find((o) => o.id === optionId);
    if (!option) return { ok: false, text: tMenus(locale, 'opt_no_longer_offered', { agent: state.agentId }) };
    const choice = option.options.find((c) => c.value === value);
    if (!choice) return { ok: false, text: tMenus(locale, 'opt_value_no_longer_offered', { name: option.name, value }) };
    const session = warm.session;
    if (!session.setOption) return { ok: false, text: tMenus(locale, 'opt_runtime_unsupported', { agent: state.agentId }) };
    try {
      // The list survives a reclaimed child; the change itself needs the child back.
      await session.ensureSession?.(this.ctx.tokens.tokenFor(id));
      const options = await session.setOption(optionId, value);
      this.ctx.status.options(id, options);
      const updated = options.find((o) => o.id === optionId);
      if (updated) this.ctx.modelCatalog.noteOptionDefault(state.agentId, updated);
      console.log(`[option] ${id}: ${optionId} set to ${value} from the setting switch`);
      return { ok: true, options, text: tMenus(locale, 'opt_set_success', { name: option.name, choice: choice.name }) };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The status line's effort switch: `/effort`'s checks, memory and sentences, as a menu click has them. */
  private async chooseEffortFor(id: ConversationId, state: ConversationState | undefined, value: string): Promise<SessionOptionResult> {
    // As for a setting: the list survives a reclaimed child, and a change made without it would be
    // deferred while the strip and the list went on reading the level from before. A failed start
    // leaves it deferred, as `/effort` would.
    await this.ctx.agents.peek(id)?.ensureSession?.(this.ctx.tokens.tokenFor(id)).catch(() => undefined);
    const result = state ? await this.applyEffortChoice(id, state.agentId, value) : ({ kind: 'gone' } as const);
    const text = effortChoiceText(result, localeOf(this.ctx.config));
    if (result.kind !== 'applied') return { ok: false, text };
    console.log(`[effort] ${id}: switched to ${result.effort} from the effort switch`);
    return { ok: true, options: this.ctx.agents.peek(id)?.sessionOptions?.() ?? [], text, effort: result.effort };
  }

  private agentForRef(id: ConversationId, ref: ConversationRef): string {
    return this.ctx.conversations.get(id)?.agentId ?? this.ctx.boundAgentFor(id, resolveAgent(this.ctx.config, routeInputFromRef(ref)).agentId);
  }

  // ───────────────────────────── working directory (`/cd`) ─────────────────────────────

  /** Read every remote agent's root ahead of the first bare `/cc` (at start and after `/reload`). */
  warmRemoteScans(): void {
    const seen = new Set<string>();
    for (const def of this.ctx.config.agents) {
      if (!def.host) continue;
      const k = `${def.host}\0${resolveAgentCwd(def)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      void this.refreshRemoteScan(def);
    }
  }

  /**
   * Run `then` (a menu offered on the side) once a remote listing is in, at most
   * REMOTE_LISTING_WAIT_MS. A failed listing waits like a missing one: answering from it is
   * answering without a menu.
   */
  afterRemoteListing(def: AgentDef | undefined, then: () => void): void {
    if (!def?.host) {
      then();
      return;
    }
    if (this.remoteScans.get(`${def.host}\0${resolveAgentCwd(def)}`)?.ok) {
      then();
      void this.refreshRemoteScan(def);
      return;
    }
    let done = false;
    let cancel: () => void = () => {};
    const go = (): void => {
      if (done) return;
      done = true;
      cancel();
      then();
    };
    cancel = this.ctx.clock.schedule(go, REMOTE_LISTING_WAIT_MS);
    void this.refreshRemoteScan(def).then(go);
  }

  /** List a remote agent's root into remoteScans. Never rejects: a failure is the scan. */
  async refreshRemoteScan(def: AgentDef): Promise<void> {
    if (!def.host) return;
    await this.fetchRemoteDir(def, resolveAgentCwd(def), true);
  }

  private storeRemoteScan(key: string, entry: RemoteListingCache): void {
    const existing = this.remoteScans.get(key);
    // Keep a previously successful listing on transient background refresh failure.
    if (!entry.ok && existing?.ok) return;
    if (this.remoteScans.has(key)) this.remoteScans.delete(key);
    this.remoteScans.set(key, entry);
    if (this.remoteScans.size > MAX_REMOTE_SCANS) {
      const oldest = this.remoteScans.keys().next().value;
      if (oldest !== undefined) this.remoteScans.delete(oldest);
    }
  }

  private fetchRemoteDir(def: AgentDef, dir: string, resolveRoot = false): Promise<RemoteListingCache> {
    const hostId = def.host;
    if (!hostId) {
      return Promise.resolve({ ok: false, reason: 'agent has no remote host', at: this.ctx.clock.now() });
    }
    const host = remoteHosts.hostFor(def);
    if (!host) {
      return Promise.resolve({ ok: false, reason: `host "${hostId}" is not connected`, at: this.ctx.clock.now() });
    }
    const initialKey = `${hostId}\0${dir}`;
    const pending = this.remoteScansInFlight.get(initialKey);
    if (pending) return pending;
    const task = (async (): Promise<RemoteListingCache> => {
      let actualDir = dir;
      let result: RemoteListingCache;
      try {
        await host.ready();
        if (resolveRoot) actualDir = resolveAgentCwd(def); // `~` resolves once the host has been reached
        const entries = await host.listDir(actualDir, 15_000);
        result = { ok: true, entries, at: this.ctx.clock.now() };
      } catch (e) {
        result = { ok: false, reason: e instanceof Error ? e.message : String(e), at: this.ctx.clock.now() };
      }
      this.storeRemoteScan(`${hostId}\0${actualDir}`, result);
      return result;
    })().finally(() => {
      this.remoteScansInFlight.delete(initialKey);
    });
    this.remoteScansInFlight.set(initialKey, task);
    return task;
  }

  private toWorkdirScan(dir: string, listing: RemoteListingCache, root: string): WorkdirScan {
    if (!listing.ok) return { ok: false, reason: listing.reason };
    return this.rankWorkdirScan(workdirScanFrom(dir, listing.entries, true, root));
  }

  private remoteScanOf(def: AgentDef, root: string): WorkdirScan {
    const cached = this.remoteScans.get(`${def.host}\0${root}`);
    if (!cached) {
      return { ok: false, reason: `the directory list on host "${def.host}" has not been read yet` };
    }
    return this.toWorkdirScan(root, cached, root);
  }

  /** The `/cd` options: the root keeps the first slot (the way back out), the rest by frecency. */
  private rankedWorkdirs(def: AgentDef, root: string): WorkdirScan {
    const scan = def.host ? this.remoteScanOf(def, root) : scanWorkdirs(root);
    return this.rankWorkdirScan(scan);
  }

  private rankWorkdirScan(scan: WorkdirScan): WorkdirScan {
    if (!scan.ok || !this.ctx.workdirUsage) return scan;
    const sort = this.ctx.config.workdir?.sort ?? 'name';
    if (sort === 'name') return scan;
    const [first, ...rest] = scan.options;
    if (!first) return scan;
    return {
      ...scan,
      options: [
        first,
        ...rankByFrecency(rest, (o) => o.path, this.ctx.workdirUsage.statOf, this.ctx.clock.now()),
      ],
    };
  }

  /** Scan an arbitrary directory for an agent (used when browsing parent or subdirectories). */
  async scanWorkdirAt(
    agentId: string,
    dir: string,
    opts?: { readonly cachedOnly?: boolean }
  ): Promise<WorkdirScan> {
    const def = findAgent(this.ctx.config, agentId);
    if (!def) return { ok: false, reason: `agent "${agentId}" is not configured` };
    const root = resolveAgentCwd(def);
    if (!def.host) return this.rankWorkdirScan(scanWorkdirs(dir, root));
    const host = remoteHosts.hostFor(def);
    if (!host) return { ok: false, reason: `host "${def.host}" is not connected` };
    const key = `${def.host}\0${dir}`;
    const cached = this.remoteScans.get(key);
    if (cached?.ok) {
      if (this.ctx.clock.now() - cached.at >= REMOTE_SCAN_TTL_MS) {
        void this.fetchRemoteDir(def, dir);
      }
      return this.toWorkdirScan(dir, cached, root);
    }
    if (opts?.cachedOnly) {
      void this.fetchRemoteDir(def, dir);
      return { ok: false, reason: 'not cached' };
    }
    const listing = await this.fetchRemoteDir(def, dir);
    return this.toWorkdirScan(dir, listing, resolveAgentCwd(def));
  }

  /** Post a directory menu; false (silently) whenever there is nothing to ask, so the caller falls through. */
  offerWorkdirMenu(id: ConversationId, agentId: string, conv: ConversationRef): boolean {
    const caps = this.ctx.platforms.get(conv.platform)?.capabilities;
    const def = findAgent(this.ctx.config, agentId);
    if (!this.ctx.store || !this.ctx.hooks?.onWorkdirMenuRequest || !caps || !def) return false;
    if (this.isWorkdirLocked(id, agentId)) return false;

    const root = resolveAgentCwd(def);
    if (def.host && !this.remoteScans.has(`${def.host}\0${root}`)) {
      // Never listed yet: read it for next time, and stay quiet now rather than hold up the caller.
      void this.refreshRemoteScan(def);
      return false;
    }
    const scan = this.rankedWorkdirs(def, root);
    if (!scan.ok || workdirMenuSurface(caps, scan.options.length) !== 'menu') return false;

    this.ctx.hooks.onWorkdirMenuRequest(id, agentId, conv, {
      options: scan.options,
      current: this.ctx.workdirOf(id, agentId) ?? scan.options[0]!.path,
      truncated: scan.truncated,
      root,
      browsing: root,
      ...(def.host ? { host: def.host, posixPaths: true } : {}),
    });
    return true;
  }

  /** After `/agent` chose an agent, ask where it works — only while the answer is free (no session here). */
  offerPlacement(key: ConversationId, agentId: string, conv: ConversationRef): void {
    if (this.ctx.boundAgentFor(key, '') !== agentId) return;
    if (this.isWorkdirLocked(key, agentId)) return;
    this.afterRemoteListing(findAgent(this.ctx.config, agentId), () => this.offerWorkdirMenu(key, agentId, conv));
  }

  /** Once a session has started (persisted or first turn in flight), the working directory cannot change. */
  isWorkdirLocked(id: ConversationId, agentId: string): boolean {
    if (this.ctx.store?.agentSession(id, agentId) !== undefined) return true;
    const state = this.ctx.conversations.get(id);
    return Boolean(state && (state.turnStarted || state.turnCompleted || state.merger.runningSince() !== undefined));
  }

  /** `/cd`: the menu, the list as text, or a move by path or substring; undefined when a menu went out. */
  applyWorkdirCommand(
    id: ConversationId,
    agentId: string,
    rest: string | undefined,
    msg: InboundMessage
  ): string | undefined {
    const locale = localeOf(this.ctx.config);
    const def = findAgent(this.ctx.config, agentId);
    if (!def) return tMenus(locale, 'workdir_no_agent', { agentId });
    const root = resolveAgentCwd(def);
    const current = this.ctx.workdirOf(id, agentId) ?? root;
    if (this.isWorkdirLocked(id, agentId)) {
      return workdirChoiceText({ kind: 'locked', path: current }, locale);
    }
    const scan = this.rankedWorkdirs(def, root);
    if (!scan.ok) return workdirUnreadableText(root, scan.reason, locale);

    const query = rest?.trim();
    if (!query) {
      if (this.offerWorkdirMenu(id, agentId, msg.conversation)) return undefined;
      const text = workdirSummaryText(current, scan.options, locale);
      return scan.truncated > 0
        ? `${text}${tMenus(locale, 'workdir_summary_more', { truncated: scan.truncated })}`
        : text;
    }

    const match = matchWorkdirs(scan.options, query);
    if (match.kind === 'none') return workdirNoMatchText(query, locale);
    if (match.kind === 'many') return workdirAmbiguousText(query, match.matches, locale);
    return workdirChoiceText(this.setWorkdir(id, agentId, match.option.path), locale);
  }

  /**
   * Move a conversation to a directory: record it, drop every session id (a session is pinned to its
   * directory) and the child standing in the old one. Picking the current directory destroys nothing:
   * tapping the ● entry is how a menu is dismissed.
   */
  setWorkdir(id: ConversationId, agentId: string, path: string): WorkdirChoiceResult {
    const store = this.ctx.store;
    if (!store) {
      return {
        kind: 'failed',
        reason: 'this deployment keeps no conversation store, so a directory cannot be remembered',
      };
    }
    const def = findAgent(this.ctx.config, agentId);
    const root = def ? resolveAgentCwd(def) : undefined;
    if ((this.ctx.workdirOf(id, agentId) ?? root) === path) return { kind: 'unchanged', path };
    // Re-checked, not trusted from the menu (a snapshot); a remote one is checked by the spawn instead.
    if (!def?.host && !isDirectory(path)) return { kind: 'missing', path };

    // Back at the root clears the override, so a later edit to `agents[].cwd` still moves it.
    store.setConversationCwd(id, agentId, path === root ? undefined : path);
    store.clearAgentSessions(id);
    store.bumpGeneration?.(id);
    this.ctx.agents.dispose(id);
    this.ctx.workdirUsage?.record(path, this.ctx.clock.now());

    const state = this.ctx.conversations.get(id);
    if (state) {
      state.headerSent = false;
      this.ctx.forgetUsage(id, state);
    }
    const lane = this.ctx.laneFor(id);
    if (lane) this.ctx.platforms.get(lane.platformId)?.workbench?.refreshWorkdir(lane.address);
    console.log(`[workdir] ${id} → ${path} (agent ${agentId}; every session id dropped)`);
    return { kind: 'applied', path };
  }

  /** A clicked directory. No state yet is fine (the directory lives in the store); a rebind is not. */
  applyWorkdirChoice(
    id: ConversationId,
    expectAgentId: string,
    path: string
  ): WorkdirChoiceResult {
    const state = this.ctx.conversations.get(id);
    if (state && state.agentId !== expectAgentId) {
      const def = findAgent(this.ctx.config, state.agentId);
      return { kind: 'rebound', agent: agentDisplayName(def, state.agentId) };
    }
    if (this.isWorkdirLocked(id, expectAgentId)) {
      const def = findAgent(this.ctx.config, expectAgentId);
      const current = this.ctx.workdirOf(id, expectAgentId) ?? (def ? resolveAgentCwd(def) : path);
      return { kind: 'locked', path: current };
    }
    return this.setWorkdir(id, expectAgentId, path);
  }

  /** One agent's directory choices as `/cd` offers them: root first, then its projects. */
  workdirChoices(agentId: string): { root: string; dirs: string[] } | undefined {
    const def = findAgent(this.ctx.config, agentId);
    if (!def) return undefined;
    const root = resolveAgentCwd(def);
    const scan = this.rankedWorkdirs(def, root);
    if (!scan.ok) return { root, dirs: [] };
    return { root, dirs: scan.options.slice(1).map((o) => o.path) };
  }
}

/** A session's own settings, or undefined when it has none: an empty list is no answer. */
function nonEmpty(options: SessionOption[] | undefined): SessionOption[] | undefined {
  return options && options.length > 0 ? options : undefined;
}

function selectorModelLabel(selector: { current?: string; options: Array<{ value: string; name: string }> } | undefined): string | undefined {
  if (!selector?.current) return undefined;
  return selector.options.find((o) => o.value === selector.current)?.name ?? selector.current;
}

function peekOptionStatus(
  kind: { id: string; name: string; defaultValue?: string; defaultNote?: string },
  fresh: boolean,
): StatusOption {
  return {
    id: kind.id,
    name: kind.name,
    ...(fresh && kind.defaultValue !== undefined ? { value: kind.defaultValue } : {}),
    ...(fresh && kind.defaultNote ? { note: kind.defaultNote } : {}),
  };
}
