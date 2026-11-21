import type { AgentDef } from '../config/schema.js';
import type { AgentModelList, AgentModes } from '../core/settings.js';
import type { ModelSelector, SessionModeSelector, SessionOption } from '../types.js';
import type { AgentFactory } from './agent.js';

/**
 * What each agent's model list is, as far as the gateway can tell — for the settings screen, where
 * any agent's default model can be set from any conversation.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * A model list is not in the config. Under ACP it arrives with `session/new`, so it exists only
 * where a session of that agent is live — and a conversation has at most one. The settings screen
 * used to offer a list for the agent answering the conversation it was opened in, and only once
 * that agent had replied; every other agent's row was a page saying "type a name" (2026-11-05).
 * This answers for any agent, in this order:
 *
 *  1. a live session of that agent in ANY conversation — the freshest list there is;
 *  2. what an earlier answer said;
 *  3. ask: bring a session of that agent up just to read its list, and put it away again.
 *
 * ── The cost of asking ────────────────────────────────────────────────────────
 * Step 3 starts the agent's child (on its host, for a pod's), sends `session/new` in its default
 * workspace and disposes it: a second or two, and a harness that records sessions keeps a record of
 * an empty one. It is paid once per agent definition per daemon run — the answer is kept against the
 * definition object, so a `/reload` that changes the agent (and replaces every definition) asks
 * again rather than serving a list from before. A failure is kept too, but asked again the next time
 * the row is opened: an agent that did not start may start now.
 *
 * Never on a turn's path: only a settings screen asks, showing "asking…" while it does, and a new
 * topic's status line (see below), which shows nothing until the answer is in.
 *
 * ── Modes too ─────────────────────────────────────────────────────────────────
 * The same session reports the harness's modes (the config option of category `mode`), which is
 * what the permission rows offer levels from (core/permission-levels.ts). One ask answers both, and
 * both are kept against the same definition; a list learned elsewhere (`note`) carries no modes, so
 * a permission row opened after it asks once more.
 *
 * ── And the agent's own settings ──────────────────────────────────────────────
 * Which settings of its own (SessionOption) the agent has — names only, never their state, which
 * belongs to each session. The web UI's status line asks for these before a new topic's first
 * message, because that is the one time a setting like an account can still be changed, and there is
 * no session yet to read it from (ConversationRegistry.optionStatusForRef). Learned from any live
 * session of the agent, else from the same ask; a failed ask counts as "none", since the status line
 * asks unprompted and must not start a failing agent again every time a topic is drawn.
 */

/** How long an agent may take to come up before the answer is "it did not". */
export const PROBE_TIMEOUT_MS = 60_000;

/** A setting an agent has, by id and label: what a status line can draw before any session exists. */
export interface OptionKind {
  id: string;
  name: string;
  /** Default display value reported by a fresh session of this agent, when known. */
  defaultValue?: string;
  /** Default description for that value, when the agent gave one. */
  defaultNote?: string;
}

export interface ModelCatalogDeps {
  agents: AgentFactory;
  /** The agent's definition as the live config has it now. Its identity is the cache key. */
  defOf(agentId: string): AgentDef | undefined;
  /** A selector from a live session of this agent in some conversation, if any has one. */
  liveSelector(agentId: string): ModelSelector | undefined;
  /** The modes a live session of this agent reports, in some conversation, if any does. */
  liveModes(agentId: string): SessionModeSelector | undefined;
  /** The settings a live session of this agent reports (empty: it has none), if any session has reported. */
  liveOptions?(agentId: string): SessionOption[] | undefined;
  /** A token for the session the catalog starts itself (its MCP bridge needs one). */
  tokenFor(sessionId: string): string;
  /** Forget what that session left behind: its store entry, its token. */
  forget(sessionId: string): void;
}

export class ModelCatalog {
  private readonly known = new WeakMap<AgentDef, AgentModelList>();
  private readonly knownModes = new WeakMap<AgentDef, AgentModes>();
  private readonly knownOptions = new WeakMap<AgentDef, OptionKind[]>();
  private readonly knownDefaultModel = new WeakMap<AgentDef, string>();
  private readonly probed = new WeakSet<AgentDef>();
  private readonly asking = new WeakMap<AgentDef, Promise<AgentModelList>>();

  constructor(private readonly deps: ModelCatalogDeps) {}

  /** What is known now, without asking: undefined when nothing is. */
  get(agentId: string): AgentModelList | undefined {
    const def = this.deps.defOf(agentId);
    if (!def) return undefined;
    const live = this.deps.liveSelector(agentId);
    if (live && live.options.length > 0) {
      const list: AgentModelList = { kind: 'list', options: live.options };
      this.known.set(def, list);
      return list;
    }
    if (this.asking.has(def)) return { kind: 'loading' };
    return this.known.get(def);
  }

  /**
   * Record what was learned elsewhere — a conversation's own session brought up for `/model`
   * (ConversationRegistry.deferCustomCommand) — so the next question about this agent is answered
   * without asking.
   */
  note(agentId: string, answer: AgentModelList): void {
    const def = this.deps.defOf(agentId);
    if (def) this.known.set(def, answer);
  }

  /**
   * Update a cached option's fresh-session default after the person changed it (e.g. switching a
   * multi-account agent's active account, which the agent remembers for future sessions). Keeps
   * other cached options untouched so a locked setting on one conversation never overwrites them.
   */
  noteOptionDefault(agentId: string, option: SessionOption): void {
    const def = this.deps.defOf(agentId);
    if (!def) return;
    const known = this.knownOptions.get(def);
    if (!known) return;
    const cur = option.current !== undefined ? option.options.find((c) => c.value === option.current) : undefined;
    const defaultValue = option.current !== undefined ? (cur?.name ?? option.current) : undefined;
    const defaultNote = cur?.description;
    this.knownOptions.set(
      def,
      known.map((k) =>
        k.id === option.id
          ? {
              id: k.id,
              name: option.name,
              ...(defaultValue !== undefined ? { defaultValue } : {}),
              ...(defaultNote ? { defaultNote } : {}),
            }
          : k,
      ),
    );
  }

  /** Whether opening this agent's list should ask: nothing known, or the last ask failed. */
  shouldAsk(agentId: string): boolean {
    const known = this.get(agentId);
    return known === undefined || known.kind === 'error';
  }

  /** The agent's modes as far as known now, without asking — `get` for the permission rows. */
  modes(agentId: string): AgentModes | undefined {
    const def = this.deps.defOf(agentId);
    if (!def) return undefined;
    const live = this.deps.liveModes(agentId);
    if (live && live.options.length > 0) {
      // `current` rides along: a permission row with no level set shows what its mode adds up to,
      // and the live session's mode is the one that is actually in force.
      const modes: AgentModes = {
        kind: 'list',
        options: live.options,
        ...(live.current ? { current: live.current } : {}),
      };
      this.knownModes.set(def, modes);
      return modes;
    }
    if (this.asking.has(def)) return { kind: 'loading' };
    return this.knownModes.get(def);
  }

  /** Whether opening this agent's permission row should ask — `shouldAsk` for the modes. */
  shouldAskModes(agentId: string): boolean {
    const known = this.modes(agentId);
    return known === undefined || known.kind === 'error';
  }

  /** The agent's default model display name as far as known now, without asking. */
  defaultModel(agentId: string): string | undefined {
    const def = this.deps.defOf(agentId);
    if (!def) return undefined;
    const known = this.knownDefaultModel.get(def);
    if (known) return known;
    const live = this.deps.liveSelector(agentId);
    return live ? currentModelLabel(live) : undefined;
  }

  /** The agent's own settings as far as known now, without asking: undefined when nothing is. */
  options(agentId: string): OptionKind[] | undefined {
    const def = this.deps.defOf(agentId);
    if (!def) return undefined;
    if (this.probed.has(def)) return this.knownOptions.get(def);
    const live = this.deps.liveOptions?.(agentId);
    if (live) {
      const kinds = optionKinds(live, false);
      this.knownOptions.set(def, kinds);
      return kinds;
    }
    return this.knownOptions.get(def);
  }

  /**
   * The agent's own settings, asking when nothing is known (once at a time, sharing an ask already
   * running for the models). Never rejects; empty when the agent has none or could not be asked.
   */
  async learnOptions(agentId: string): Promise<OptionKind[]> {
    const def = this.deps.defOf(agentId);
    if (!def) return [];
    if (this.probed.has(def)) return this.knownOptions.get(def) ?? [];
    const known = this.options(agentId);
    // A live session from another conversation may have locked its own setting (single choice) and
    // therefore carries no fresh-session default; probe once so a new topic sees the real defaults.
    if (known && (known.length === 0 || known.every((k) => k.defaultValue !== undefined))) return known;
    await this.ask(agentId);
    return this.knownOptions.get(def) ?? [];
  }

  /** Ask for the list, once at a time per agent; resolves to the answer, never rejects. */
  ask(agentId: string): Promise<AgentModelList> {
    const def = this.deps.defOf(agentId);
    if (!def) return Promise.resolve({ kind: 'error', reason: `no agent named ${agentId}` });
    const running = this.asking.get(def);
    if (running) return running;
    const p = this.probe(def).then(({ models, modes, options, defaultModel }) => {
      this.known.set(def, models);
      this.knownModes.set(def, modes);
      // Keep live-learned options if a probe failed or returned nothing.
      if (options.length > 0 || !this.knownOptions.has(def)) this.knownOptions.set(def, options);
      if (defaultModel) this.knownDefaultModel.set(def, defaultModel);
      this.probed.add(def);
      this.asking.delete(def);
      return models;
    });
    this.asking.set(def, p);
    return p;
  }

  /** Start a session of the agent under an id no conversation has, read its selectors, dispose it. */
  private async probe(
    def: AgentDef,
  ): Promise<{ models: AgentModelList; modes: AgentModes; options: OptionKind[]; defaultModel?: string }> {
    const sid = `models:${def.id}`;
    const started = Date.now();
    let session;
    try {
      session = this.deps.agents.getOrCreate(sid, def.id);
      let selector = session.modelSelector?.();
      if (!selector && session.ensureSession) {
        await withTimeout(session.ensureSession(this.deps.tokenFor(sid)), PROBE_TIMEOUT_MS);
        selector = session.modelSelector?.();
      }
      const models: AgentModelList =
        selector && selector.options.length > 0 ? { kind: 'list', options: selector.options } : { kind: 'none' };
      const defaultModel = selector ? currentModelLabel(selector) : undefined;
      const offered = session.permissionModes?.();
      const modes: AgentModes =
        offered && offered.options.length > 0
          ? { kind: 'list', options: offered.options, ...(offered.current ? { current: offered.current } : {}) }
          : { kind: 'none' };
      const options = optionKinds(session.sessionOptions?.(), true);
      console.log(`[models] asked ${def.id} ${answerLine(models, modes, options)} (${Date.now() - started}ms)`);
      return { models, modes, options, ...(defaultModel ? { defaultModel } : {}) };
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown';
      console.warn(`[models] could not ask ${def.id} for its models: ${reason}`);
      return { models: { kind: 'error', reason }, modes: { kind: 'error', reason }, options: [] };
    } finally {
      if (session) this.deps.agents.dispose(sid);
      this.deps.forget(sid);
    }
  }
}

function currentModelLabel(selector: ModelSelector): string | undefined {
  if (!selector.current) return undefined;
  return selector.options.find((o) => o.value === selector.current)?.name ?? selector.current;
}

function optionKinds(options: SessionOption[] | undefined, fresh: boolean): OptionKind[] {
  return (options ?? []).map((o) => {
    // A locked setting (single option) on another conversation's live session reflects that
    // conversation's bound choice, not a new conversation's default.
    const includeDefault = fresh || o.options.length > 1;
    const cur = includeDefault && o.current !== undefined ? o.options.find((c) => c.value === o.current) : undefined;
    const defaultValue = includeDefault && o.current !== undefined ? (cur?.name ?? o.current) : undefined;
    return {
      id: o.id,
      name: o.name,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(cur?.description ? { defaultNote: cur.description } : {}),
    };
  });
}

/** What one ask learned, for its log line. */
function answerLine(models: AgentModelList, modes: AgentModes, options: OptionKind[]): string {
  const list = (xs: string[]): string => (xs.length > 0 ? xs.join(' ') : 'none');
  return (
    `for its models: ${models.kind === 'list' ? `${models.options.length}` : 'none offered'}, ` +
    `modes: ${list(modes.kind === 'list' ? modes.options.map((m) => m.value) : [])}, ` +
    `settings: ${list(options.map((o) => o.id))}`
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
