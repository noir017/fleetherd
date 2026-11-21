import { join } from 'node:path';
import type { AgentDef } from '../config/schema.js';
import { findAgent } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { SoloOutcome } from '../core/inbound-merger.js';
import { fallbackTitle } from '../core/title-namer.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId, InboundMessage } from '../types.js';
import { expandHome, resolveAgentCwd } from './agent-common.js';
import type { ConversationContext } from './conversation-context.js';
import { formatLaneTitle, type ConversationControls } from './conversation-controls.js';
import type { ConversationTurns } from './conversation-turns.js';
import { DELEGATE_SENDER, SCHEDULED_SENDER } from './turn-runner.js';

export interface ScheduledConversationOptions {
  platform: string;
  address: ConversationAddress;
  agentId: string;
  title: string;
  cwd?: string;
  ephemeralKey: ConversationId;
  /** The task this run belongs to, recorded on the topic where a platform keeps one (the web UI). */
  task?: string;
  /** A daily session must be a topic the user can reply into: no silent downgrade to a throwaway. */
  mustOpen?: boolean;
}

export interface OpenTaskOptions {
  platform: string;
  parent: ConversationAddress;
  agentId: string;
  text: string;
  header: string;
  cwd?: string;
  title?: string;
  model?: string;
  /** A reply handed over with the task, as `task-send --forward` attaches one (the review loop's first review). */
  forward?: { heading: string; text: string };
}

/**
 * Work that reaches a conversation from outside it: scheduled runs (daemon/scheduler.ts) and the
 * sub-agents' topics (daemon/delegation.ts) — opening the topic, applying a task's model, handing
 * the text in.
 */
export class ConversationDelegation {
  /** Unique per call, so two overlapping model probes for one agent cannot dispose each other's session. */
  private modelProbeSeq = 0;

  constructor(
    private readonly ctx: ConversationContext,
    private readonly turns: ConversationTurns,
    private readonly controls: ConversationControls
  ) {}

  // ───────────────────────────── scheduled runs ─────────────────────────────

  /**
   * One scheduled prompt as its own solo turn, interrupting nothing. Refuses rather than rebinds a
   * topic now answered by another agent: a schedule must not undo a person's choice.
   */
  runScheduledPrompt(opts: {
    key: ConversationId;
    platform: string;
    address: ConversationAddress;
    agentId: string;
    prompt: string;
    user?: string;
  }): Promise<SoloOutcome | { refused: string }> {
    const state = this.ctx.ensureState(opts.key, opts.platform, opts.agentId);
    if (state.agentId !== opts.agentId) {
      return Promise.resolve({ refused: `this topic is now answered by ${state.agentId}, not ${opts.agentId}` });
    }
    state.reclaimOnIdle = false;
    this.ctx.touch(opts.key);
    const msg: InboundMessage = {
      conversation: {
        platform: opts.platform,
        channel: opts.address.channel,
        ...(opts.address.thread ? { thread: opts.address.thread } : {}),
        kind: 'direct',
        user: opts.user ?? SCHEDULED_SENDER,
      },
      // No platform message behind it: the merger puts no reactions on a solo turn.
      messageId: '',
      content: opts.prompt,
      timestamp: this.ctx.clock.now(),
    };
    return state.merger.enqueueSolo(msg);
  }

  /**
   * Whether `agentId` offers `model` (`schedule add --model`, `task-new --model`). Another agent's
   * list is read under a throwaway key, never the caller's: one conversation belongs to one agent.
   */
  async scheduledModelProblem(agentId: string, model: string, from: ConversationId | undefined): Promise<string | undefined> {
    // `from` is undefined for the web UI's task page, which has no conversation to borrow a session from.
    const same = from !== undefined && this.ctx.boundAgentOf(from) === agentId;
    const key = same ? from : `__schedule-model__#${agentId}#${++this.modelProbeSeq}`;
    const session = this.ctx.agents.getOrCreate(key, agentId);
    try {
      let selector = session.modelSelector?.();
      if (!selector && session.ensureSession) {
        try {
          await session.ensureSession(this.ctx.tokens.tokenFor(key));
        } catch (e) {
          return `could not ask agent "${agentId}" for its models: ${e instanceof Error ? e.message : String(e)}`;
        }
        selector = session.modelSelector?.();
      }
      if (!selector) {
        return `agent "${agentId}" has no model list (its harness has no model selector), so --model cannot be used with it; drop --model to use the agent's configured model`;
      }
      if (!selector.options.some((o) => o.value === model)) {
        return `unknown model "${model}" for agent "${agentId}"; choose one of: ${selector.options.map((o) => o.value).join(', ')}`;
      }
      return undefined;
    } finally {
      if (!same) {
        this.ctx.agents.dispose(key);
        this.ctx.tokens.release(key);
      }
    }
  }

  /**
   * Put a task's model on its conversation before the turn. An override already there wins (a
   * person's `/model` must not be undone by a timer); a refusal fails the run, never a silent switch.
   */
  async applyScheduledModel(key: ConversationId, platform: string, agentId: string, model: string): Promise<string | undefined> {
    const state = this.ctx.ensureState(key, platform, agentId);
    if (state.agentId !== agentId) return `this topic is now answered by ${state.agentId}, not ${agentId}`;
    if (state.modelOverride !== undefined) return undefined;
    const session = this.ctx.agents.getOrCreate(key, agentId);
    if (!session.setModel) return `agent "${agentId}" cannot switch models at runtime`;
    if (session.ensureSession) {
      try {
        await session.ensureSession(this.ctx.tokens.tokenFor(key));
      } catch (e) {
        return `could not start the session to set model "${model}": ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    try {
      state.modelOverride = await session.setModel(model);
      return undefined;
    } catch (e) {
      return `could not set model "${model}": ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Where a new-session run happens: a new topic when the platform can open one, else a throwaway
   * conversation (`ephemeral`). `mustOpen` (a daily session) raises instead of falling back. The
   * name is recorded, so the automatic namer leaves the topic alone.
   */
  async openScheduledConversation(opts: ScheduledConversationOptions): Promise<{ key: ConversationId; address: ConversationAddress; ephemeral: boolean }> {
    const adapter = this.ctx.platforms.get(opts.platform);
    if (!adapter) throw new Error(`platform instance "${opts.platform}" is not running`);
    // Asked BEFORE createThread, or a refused daily run leaves an empty topic behind every time.
    if (opts.mustOpen && !this.ctx.conversationAt(opts.platform, opts.address)) {
      throw new Error('the target does not map to a conversation of its own under this deployment\'s scope; a daily-session task needs one');
    }
    const title = formatLaneTitle(opts.agentId, opts.title);
    const opened = await this.openScheduledTopic(adapter, opts.address, title, opts.mustOpen === true, opts.task);
    const conv = opened ? this.ctx.conversationAt(opts.platform, opened) : undefined;
    if (opts.mustOpen && !conv) {
      throw new Error('the new topic does not map to a conversation of its own under this deployment\'s scope');
    }
    const key = conv?.key ?? opts.ephemeralKey;
    const address = opened && conv ? opened : opts.address;
    this.ctx.ensureState(key, opts.platform, opts.agentId, { fresh: true });
    if (opts.cwd) this.ctx.store?.setConversationCwd(key, opts.agentId, opts.cwd);
    if (key !== opts.ephemeralKey) this.ctx.store?.setConversationTitle(key, opts.agentId, title);
    return { key, address, ephemeral: key === opts.ephemeralKey };
  }

  private async openScheduledTopic(
    adapter: PlatformAdapter,
    address: ConversationAddress,
    title: string,
    mustOpen: boolean,
    task: string | undefined
  ): Promise<ConversationAddress | undefined> {
    if (!adapter.capabilities.thread) {
      if (mustOpen) throw new Error(`platform instance "${adapter.platform}" cannot open a topic`);
      return undefined;
    }
    try {
      const opened = (
        await adapter.createThread({ address, messageId: '' }, title, { scheduled: true, ...(task !== undefined ? { task } : {}) })
      ).address;
      // No `thread` names the channel (Slack echoes the empty messageId): posting there would land in the
      // person's own topic, and a daily task would persist a thread the store's schema later rejects.
      if (!opened.thread) {
        throw new Error(`platform instance "${adapter.platform}" did not open a topic of its own (it needs a message to reply to)`);
      }
      return opened;
    } catch (e) {
      if (mustOpen) throw e;
      console.warn(`[schedule] could not open a topic on ${adapter.platform}; posting into the chat instead: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /** Forget a throwaway scheduled conversation entirely: its child, its state, its record. */
  releaseScheduled(key: ConversationId): void {
    this.ctx.agents.dispose(key);
    this.ctx.releaseState(key);
    this.ctx.store?.clear(key);
  }

  // ───────────────────────────── sub-agents' topics ─────────────────────────────

  /**
   * Open a topic of its own for confirmed work (`task-new`) under `parent`, bound to `agentId`, and
   * hand it `text`. Answers the lane title too: a topic opened a moment ago sorts last in `channels`.
   */
  async openTask(opts: OpenTaskOptions): Promise<{ key: ConversationId; address: ConversationAddress; title: string }> {
    const adapter = this.ctx.platforms.get(opts.platform);
    if (!adapter?.capabilities.thread) {
      throw new Error(`platform instance "${opts.platform}" cannot open a conversation of its own here`);
    }
    const def = findAgent(this.ctx.config, opts.agentId);
    if (!def) {
      throw new Error(`no agent "${opts.agentId}" is configured; task-agents lists them: ${this.ctx.config.agents.map((a) => a.id).join(', ')}`);
    }
    if (this.turns.draining) throw new Error('the gateway is restarting; open the task again in a minute');
    const cwd = opts.cwd ? taskDirectory(def, opts.cwd) : undefined;
    const bare = opts.title ?? fallbackTitle(opts.text);
    const name = formatLaneTitle(opts.agentId, bare);
    const opened = (await adapter.createThread({ address: { channel: opts.parent.channel }, messageId: '' }, name, { under: opts.parent }))
      .address;
    const conv = this.ctx.conversationAt(opts.platform, opened);
    if (!conv) throw new Error('the new topic does not map to a conversation of its own under this deployment\'s scope');
    this.ctx.ensureState(conv.key, opts.platform, opts.agentId, { fresh: true });
    if (opts.title) this.ctx.store?.setConversationTitle(conv.key, opts.agentId, name);
    if (cwd) {
      const moved = this.controls.setWorkdir(conv.key, opts.agentId, cwd);
      if (moved.kind === 'missing') throw new Error(`no directory ${cwd} on the machine "${opts.agentId}" runs on`);
      if (moved.kind === 'failed') throw new Error(moved.reason);
    }
    if (opts.model) {
      // Strict, like a scheduled run's: the card named this model. The topic says why nothing runs.
      const why = await this.applyScheduledModel(conv.key, opts.platform, opts.agentId, opts.model);
      if (why) {
        await adapter
          .sendMessage(opened, `Not started — ${why}.`)
          .catch((e) => console.warn(`[conversation] ${conv.key}: could not say why the task did not start:`, e instanceof Error ? e.message : e));
        throw new Error(why);
      }
      // Recorded, unlike a schedule's (re-applied every run): this topic has no next run to apply it at.
      this.ctx.store?.setConversationChoice?.(conv.key, opts.agentId, 'model', opts.model);
    }
    await this.handTo(conv.key, opts.platform, opened, opts.text, opts.header, opts.forward ? { forward: opts.forward } : {});
    // `name`, not the bare title: formatLaneTitle normalises it, and the card must match the topic.
    return { key: conv.key, address: opened, title: name };
  }

  /**
   * Hand `text` to a sub-agent's conversation under `header` (`task-new`, `task-send`): into the
   * running turn when the harness takes one, else as the next turn. `queued` is reported apart from
   * `joined` because `isBusy` alone cannot tell whether a harness takes input mid-turn (agy cannot).
   * `opts.queue` (task-send --interrupt) skips the offer to the turn being stopped.
   */
  async handTo(
    key: ConversationId,
    platformId: string,
    address: ConversationAddress,
    text: string,
    header: string,
    opts: { queue?: boolean; forward?: { heading: string; text: string } } = {}
  ): Promise<'started' | 'joined' | 'queued'> {
    const agentId = this.ctx.boundAgentOf(key);
    if (!agentId || !findAgent(this.ctx.config, agentId)) throw new Error('nobody answers that conversation yet; open it with task-new');
    const adapter = this.ctx.platforms.get(platformId);
    if (!adapter) throw new Error(`platform instance "${platformId}" is not running`);
    const state = this.ctx.ensureState(key, platformId, agentId);
    if (this.turns.draining && state.merger.isIdle()) throw new Error('the gateway is restarting; send it again in a minute');
    if (opts.forward) {
      // Posted first and awaited: the person must see the material before a task that refers to it.
      await adapter.sendMessage(address, `${opts.forward.heading}\n${opts.forward.text}`, { kind: 'report' });
    }
    if (!text && !opts.forward) throw new Error('nothing to send');
    const posted = await adapter.sendMessage(address, text ? `${header}\n\n${text}` : header, { kind: 'dispatch' });
    const busy = !state.merger.isIdle();
    const joins = !opts.queue && busy && this.turns.runner.canSteer(key);
    this.turns.outcomes.personActed(key);
    this.ctx.touch(key);
    state.reclaimOnIdle = false;
    const msg = {
      conversation: {
        platform: platformId,
        channel: address.channel,
        ...(address.thread ? { thread: address.thread } : {}),
        kind: 'direct' as const,
        user: DELEGATE_SENDER,
      },
      messageId: posted.messageId,
      content: [text, opts.forward ? `${opts.forward.heading}\n\n${opts.forward.text}` : ''].filter(Boolean).join('\n\n'),
      timestamp: this.ctx.clock.now(),
    };
    if (opts.queue) state.merger.queueBehind(msg);
    else void state.merger.ingest(msg);
    return !busy ? 'started' : joins ? 'joined' : 'queued';
  }
}

/** A task's directory as named: absolute, `~`-relative, or a name inside the agent's root (what task-agents lists). */
function taskDirectory(def: AgentDef, given: string): string {
  if (given.startsWith('/') || given === '~' || given.startsWith('~/')) {
    return def.host ? given : expandHome(given);
  }
  const root = resolveAgentCwd(def);
  return def.host ? `${root.replace(/\/$/, '')}/${given}` : join(root, given);
}
