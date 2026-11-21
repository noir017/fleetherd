import type { AgentDef } from '../config/schema.js';
import { agentDisplayName, findAgent } from '../config/schema.js';
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
import type {
  ModelPickerList,
  ModelPickerResult,
  PlatformAdapter,
  SessionOptionList,
  SessionOptionResult,
} from '../platform/adapter.js';
import type {
  ConversationId,
  EffortSelector,
  InboundMessage,
  ModelSelector,
  SessionOption,
  StatusOption,
} from '../types.js';
import { forkRefusal } from './acp-fork.js';
import { NO_FORK } from './acp-side-question.js';
import { ForkRefused, type AgentSession } from './agent.js';
import { resolveAgentCwd } from './agent-common.js';
import type { ConversationContext, ConversationState } from './conversation-context.js';
import type { ConversationHistory } from './conversation-history.js';
import { subjectOf } from './delegation.js';
import { remoteHosts } from './remote-hosts.js';
import { resolveAgent, routeInputFromRef } from './routing.js';
import { statusOptions } from './status-board.js';
import { isDirectory, scanWorkdirs, workdirScanFrom, type WorkdirScan } from './workdir-scan.js';

/** How long a menu offered on the side (a bare `/cc`, `/new`) waits for a remote root's first listing. */
export const REMOTE_LISTING_WAIT_MS = 5_000;

const FORK_WEB_ONLY =
  '/fork works in the web UI only: the copy opens as a topic beside this one, and only the web UI has a topic list to put it in.';

/**
 * Shape a lane name: `[<agent>] <subject>`. Leading bracketed groups are stripped repeatedly, so
 * re-titling replaces the tag instead of stacking a second one.
 */
export function formatLaneTitle(agentId: string, raw: string): string {
  let subject = raw.replace(/\s+/g, ' ').trim();
  while (subject.startsWith('[')) {
    const close = subject.indexOf(']');
    if (close < 0) break;
    subject = subject.slice(close + 1).trimStart();
  }
  // Nothing but brackets: keep the original rather than name every such conversation identically.
  if (!subject) subject = raw.replace(/\s+/g, ' ').trim();
  return `[${agentId}] ${subject}`.trim();
}

/**
 * The per-conversation controls: `/model`, `/effort`, `/cd`, `/fork`, `/title`, and the web UI's
 * model and option switches. Each typed path and its clicked twin share one setter, so they cannot
 * answer differently; setters return failures as values because a click has nobody to re-prompt.
 */
export class ConversationControls {
  /** Naming calls in flight: the store gate cannot cover the seconds before the platform accepts a rename. */
  private readonly namingInFlight = new Set<ConversationId>();
  /** Last listing of each remote root: the menu code is synchronous, a remote listing is not. */
  private readonly remoteScans = new Map<string, WorkdirScan>();

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

    if (wanted.toLowerCase() === 'auto') {
      if (!current) {
        return 'I have not named this topic yet — it gets a name after the next message.';
      }
      this.ctx.store?.releaseConversationTitle(key);
      return `Forgot the name I gave this topic ("${current}"). It keeps that name until the next message, which will name it afresh.`;
    }

    if (!wanted) {
      if (!current) {
        return 'I have not named this topic. `/title <name>` to name it now, or it gets named automatically after the next message.';
      }
      return this.ctx.store?.titlePinned(key)
        ? `This topic is named "${current}" — you set it, and it will not be renamed. \`/title auto\` to have it named afresh.`
        : `I named this topic "${current}" from its opening message, and will not rename it again. \`/title <name>\` to set your own.`;
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
    if (failure) return `Could not rename this topic: ${failure}`;
    return `Renamed this topic to "${wanted}". \`/title auto\` to have it named automatically again.`;
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
    const platform = this.ctx.platforms.get(platformId);
    if (!platform?.capabilities.renameThread || !platform.renameThread) {
      return 'this platform cannot rename a conversation lane';
    }
    if (!address.thread) {
      return 'this conversation is not in a thread or topic, so there is no name to change';
    }
    const wanted = title.trim();
    if (!wanted) return 'that is an empty title';
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
    const platformId = msg.conversation.platform;
    const adapter = this.ctx.platforms.get(platformId);
    const forkThread = adapter?.forkThread?.bind(adapter);
    if (!forkThread) return FORK_WEB_ONLY;
    const agentId = this.ctx.boundAgentFor(key, fallbackAgent);
    const label = agentDisplayName(findAgent(this.ctx.config, agentId), agentId);
    if (!this.ctx.store?.agentSession(key, agentId)) {
      return `Nothing to fork yet: ${label} has no conversation here. Send it a message first.`;
    }
    const session = this.ctx.agents.getOrCreate(key, agentId);
    if (!session.forkFrom) return `${label} does not support /fork.`;
    const asked = await this.forkReady(key, session, label, agentId);
    if (asked) return asked;
    // Read again: a source whose stored session could not be reloaded just now has a fresh one.
    const sourceId = this.ctx.store?.agentSession(key, agentId);
    if (!sourceId) return `Nothing to fork yet: ${label} has no conversation here. Send it a message first.`;
    return this.makeFork({ key, address, platformId, forkThread, agentId, label, sourceId });
  }

  private async makeFork(f: {
    key: ConversationId;
    address: ConversationAddress;
    platformId: string;
    forkThread: NonNullable<PlatformAdapter['forkThread']>;
    agentId: string;
    label: string;
    sourceId: string;
  }): Promise<string> {
    const { key, address, platformId, forkThread, agentId, label, sourceId } = f;
    const turn = this.history.lastTurnOf(key);
    let opened: Awaited<ReturnType<typeof forkThread>>;
    try {
      opened = await forkThread(address, turn !== undefined ? { turn } : {});
    } catch (e) {
      return `Could not fork: ${e instanceof Error ? e.message : String(e)}`;
    }
    const conv = this.ctx.conversationAt(platformId, opened.address);
    if (!conv) {
      opened.discard();
      return "Could not fork: the new topic does not map to a conversation of its own under this deployment's scope.";
    }
    this.seedFork(key, conv.key, platformId, agentId);
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
      return e instanceof ForkRefused ? e.message : `Could not fork: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.log(`[fork] ${key} (${agentId}) → ${conv.key} at turn ${turn ?? '?'}`);
    this.warnIfForkRaced(key, turn, platformId, opened.address, label);
    const link = opened.address.thread ? `[${subjectOf(opened.title)}](?t=${opened.address.thread})` : `"${opened.title}"`;
    const at = turn !== undefined ? ` at turn ${turn}` : '';
    return `Forked into ${link}${at}: it carries on from everything said here so far, as a conversation of its own. This topic is unchanged.`;
  }

  /**
   * The refusal while a turn or background work runs, or the agent declares no fork. Whether it can
   * fork is only said in `initialize`, so a cold conversation is started first, then asked again.
   */
  private async forkReady(key: ConversationId, session: AgentSession, label: string, agentId: string): Promise<string | undefined> {
    const busy = (): string | undefined => {
      if (this.ctx.isBusy(key)) return `${label} is in the middle of a turn here. /fork once it ends: a copy taken now would hold half of that turn.`;
      if (session.backgroundActive?.()) return `${label} is still reporting on background work here. /fork once it has finished.`;
      return undefined;
    };
    const now = busy();
    if (now) return now;
    try {
      if (session.canFork?.() === undefined) await session.ensureSession?.(this.ctx.tokens.tokenFor(key));
    } catch (e) {
      return `Could not fork: ${e instanceof Error ? e.message : String(e)}`;
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
    void this.ctx.platforms
      .get(platformId)
      ?.sendMessage(
        forkAddress,
        `⚠ ${label} started a turn in the original topic while this copy was being made, so the copy may end part-way through that turn. If that matters, delete this topic and /fork again once the turn ends.`
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
    const typing = this.ctx.platforms.get(msg.conversation.platform);
    void typing?.startTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    const warm = await this.warmModelSelector(key, state.agentId);
    void typing?.stopTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    if (warm.error) return modelStartFailedText(warm.error);
    const selector = warm.selector;
    if (!selector) return modelNoSelectorText();

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
      return modelSummaryText(selector);
    }

    const match = matchModels(selector.options, query);
    if (match.kind === 'none') return modelNoMatchText(query);
    if (match.kind === 'many') return modelAmbiguousText(query, match.matches);
    return modelChoiceText(await this.setModelOn(warm.session, state, match.option.value));
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
    const typing = this.ctx.platforms.get(msg.conversation.platform);
    void typing?.startTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    const warm = await this.warmSelector(key, state.agentId, (s) => s.effortSelector?.());
    void typing?.stopTyping?.(addressOf(msg.conversation)).catch(() => undefined);
    if (warm.error) return effortStartFailedText(warm.error);
    const selector = warm.selector;
    if (!selector) {
      const def = findAgent(this.ctx.config, state.agentId);
      return effortNoSelectorText(def?.harness, warm.session.modelSelector?.()?.current);
    }

    const query = rest?.trim();
    if (!query) return this.answerBareEffort(state, key, msg, selector);

    const match = matchEfforts(selector.options, query);
    if (match.kind === 'none') return effortNoMatchText(query, selector.options);
    if (match.kind === 'many') return effortAmbiguousText(query, match.matches);
    return effortChoiceText(await this.setEffortOn(warm.session, state.agentId, match.option.value));
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
    return effortSummaryText(selector);
  }

  private async setEffortOn(session: AgentSession, agentId: string, value: string): Promise<EffortChoiceResult> {
    if (!session.setEffort) {
      return { kind: 'failed', reason: 'this agent cannot switch effort at runtime' };
    }
    try {
      const effort = await session.setEffort(value);
      this.ctx.store?.setConversationChoice?.(session.conversationId, agentId, 'effort', value);
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
    const id = this.ctx.idForRef(ref);
    const agentId =
      this.ctx.conversations.get(id)?.agentId ?? this.ctx.boundAgentFor(id, resolveAgent(this.ctx.config, routeInputFromRef(ref)).agentId);
    const state = this.ctx.ensureState(id, ref.platform, agentId, { opener: 'the model switch' });
    const warm = await this.warmModelSelector(id, state.agentId);
    if (warm.error) return { ok: false, agent: state.agentId, reason: 'error', text: modelStartFailedText(warm.error) };
    if (!warm.selector || warm.selector.options.length === 0) {
      return { ok: false, agent: state.agentId, reason: 'none', text: modelNoSelectorText() };
    }
    const liveModel = selectorModelLabel(warm.selector);
    if (liveModel) this.ctx.status.model(id, liveModel);
    const liveOpts = warm.session.sessionOptions?.();
    if (liveOpts?.length) this.ctx.status.options(id, liveOpts);
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
    const id = this.ctx.idForRef(ref);
    const state = this.ctx.conversations.get(id);
    const result = state ? await this.applyModelChoice(id, state.agentId, value) : ({ kind: 'gone' } as const);
    const text = modelChoiceText(result);
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
  async optionStatusForRef(ref: ConversationRef): Promise<{ agent: string; model?: string; options: StatusOption[] }> {
    const id = this.ctx.idForRef(ref);
    const agent = this.agentForRef(id, ref);
    const live = this.ctx.agents.peek(id);
    const own = live?.sessionOptions?.();
    if (own) {
      const model = this.peekModelFor(id, agent, live, false);
      return { agent, ...(model ? { model } : {}), options: statusOptions(own) };
    }
    const fresh = this.ctx.store?.agentSession(id, agent) === undefined;
    const kinds = fresh ? await this.ctx.modelCatalog.learnOptions(agent) : (this.ctx.modelCatalog.options(agent) ?? []);
    const model = this.peekModelFor(id, agent, live, fresh);
    return {
      agent,
      ...(model ? { model } : {}),
      options: kinds.map((k) => peekOptionStatus(k, fresh)),
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
    const id = this.ctx.idForRef(ref);
    const state = this.ctx.ensureState(id, ref.platform, this.agentForRef(id, ref), { opener: 'a setting switch' });
    const agent = state.agentId;
    const warm = await this.warmSelector(id, agent, (s) => nonEmpty(s.sessionOptions?.()));
    if (warm.error) return { ok: false, agent, reason: 'error', text: `Could not start ${agent} to ask for its settings:\n${warm.error}` };
    if (!warm.selector) return { ok: false, agent, reason: 'none', text: `${agent} has no settings of its own to change.` };
    const liveModel = selectorModelLabel(warm.session.modelSelector?.());
    if (liveModel) this.ctx.status.model(id, liveModel);
    this.ctx.status.options(id, warm.selector);
    return { ok: true, agent, options: warm.selector };
  }

  /** Set one of the agent's own settings; the agent may still refuse a listed value, in its own words. */
  async chooseOptionForRef(ref: ConversationRef, optionId: string, value: string): Promise<SessionOptionResult> {
    const id = this.ctx.idForRef(ref);
    const state = this.ctx.conversations.get(id);
    if (!state) return { ok: false, text: 'That conversation is gone — send a message first.' };
    const warm = await this.warmSelector(id, state.agentId, (s) => nonEmpty(s.sessionOptions?.()));
    if (warm.error) return { ok: false, text: `Could not start ${state.agentId}:\n${warm.error}` };
    const option = warm.selector?.find((o) => o.id === optionId);
    if (!option) return { ok: false, text: `${state.agentId} no longer offers that setting.` };
    const choice = option.options.find((c) => c.value === value);
    if (!choice) return { ok: false, text: `${option.name}: "${value}" is no longer offered.` };
    const session = warm.session;
    if (!session.setOption) return { ok: false, text: `${state.agentId} cannot change its settings at runtime.` };
    try {
      // The list survives a reclaimed child; the change itself needs the child back.
      await session.ensureSession?.(this.ctx.tokens.tokenFor(id));
      const options = await session.setOption(optionId, value);
      this.ctx.status.options(id, options);
      const updated = options.find((o) => o.id === optionId);
      if (updated) this.ctx.modelCatalog.noteOptionDefault(state.agentId, updated);
      console.log(`[option] ${id}: ${optionId} set to ${value} from the setting switch`);
      return { ok: true, options, text: `${option.name} set to ${choice.name} for this conversation.` };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
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
    const host = remoteHosts.hostFor(def);
    if (!host) return;
    let scan: WorkdirScan;
    let root = resolveAgentCwd(def);
    try {
      await host.ready();
      root = resolveAgentCwd(def); // `~` resolves once the host has been reached
      scan = workdirScanFrom(root, await host.listDir(root, 15_000), true);
    } catch (e) {
      scan = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    this.remoteScans.set(`${def.host}\0${root}`, scan);
  }

  private remoteScanOf(def: AgentDef, root: string): WorkdirScan {
    return (
      this.remoteScans.get(`${def.host}\0${root}`) ?? { ok: false, reason: `the directory list on host "${def.host}" has not been read yet` }
    );
  }

  /** The `/cd` options: the root keeps the first slot (the way back out), the rest by frecency. */
  private rankedWorkdirs(def: AgentDef, root: string): WorkdirScan {
    const scan = def.host ? this.remoteScanOf(def, root) : scanWorkdirs(root);
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

  /** Post a directory menu; false (silently) whenever there is nothing to ask, so the caller falls through. */
  offerWorkdirMenu(id: ConversationId, agentId: string, conv: ConversationRef): boolean {
    const caps = this.ctx.platforms.get(conv.platform)?.capabilities;
    const def = findAgent(this.ctx.config, agentId);
    if (!this.ctx.store || !this.ctx.hooks?.onWorkdirMenuRequest || !caps || !def) return false;

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
    });
    return true;
  }

  /** After `/agent` chose an agent, ask where it works — only while the answer is free (no session here). */
  offerPlacement(key: ConversationId, agentId: string, conv: ConversationRef): void {
    if (this.ctx.boundAgentFor(key, '') !== agentId) return;
    if (this.ctx.store?.agentSession(key, agentId) !== undefined) return;
    this.afterRemoteListing(findAgent(this.ctx.config, agentId), () => this.offerWorkdirMenu(key, agentId, conv));
  }

  /** `/cd`: the menu, the list as text, or a move by path or substring; undefined when a menu went out. */
  applyWorkdirCommand(
    id: ConversationId,
    agentId: string,
    rest: string | undefined,
    msg: InboundMessage
  ): string | undefined {
    const def = findAgent(this.ctx.config, agentId);
    if (!def) return `No agent "${agentId}" is configured, so there is no directory to change.`;
    const root = resolveAgentCwd(def);
    const scan = this.rankedWorkdirs(def, root);
    if (!scan.ok) return workdirUnreadableText(root, scan.reason);

    const current = this.ctx.workdirOf(id, agentId) ?? root;
    const query = rest?.trim();
    if (!query) {
      if (this.offerWorkdirMenu(id, agentId, msg.conversation)) return undefined;
      const text = workdirSummaryText(current, scan.options);
      return scan.truncated > 0
        ? `${text}\n(+${scan.truncated} more not shown — type part of a name to reach one.)`
        : text;
    }

    const match = matchWorkdirs(scan.options, query);
    if (match.kind === 'none') return workdirNoMatchText(query);
    if (match.kind === 'many') return workdirAmbiguousText(query, match.matches);
    return workdirChoiceText(this.setWorkdir(id, agentId, match.option.path));
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
