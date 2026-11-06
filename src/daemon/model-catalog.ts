import type { AgentDef } from '../config/schema.js';
import type { AgentModelList } from '../core/settings.js';
import type { ModelSelector } from '../types.js';
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
 * Never on a turn's path: only a settings screen asks, and it shows "asking…" while it does.
 */

/** How long an agent may take to come up before the answer is "it did not". */
export const PROBE_TIMEOUT_MS = 60_000;

export interface ModelCatalogDeps {
  agents: AgentFactory;
  /** The agent's definition as the live config has it now. Its identity is the cache key. */
  defOf(agentId: string): AgentDef | undefined;
  /** A selector from a live session of this agent in some conversation, if any has one. */
  liveSelector(agentId: string): ModelSelector | undefined;
  /** A token for the session the catalog starts itself (its MCP bridge needs one). */
  tokenFor(sessionId: string): string;
  /** Forget what that session left behind: its store entry, its token. */
  forget(sessionId: string): void;
}

export class ModelCatalog {
  private readonly known = new WeakMap<AgentDef, AgentModelList>();
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

  /** Whether opening this agent's list should ask: nothing known, or the last ask failed. */
  shouldAsk(agentId: string): boolean {
    const known = this.get(agentId);
    return known === undefined || known.kind === 'error';
  }

  /** Ask for the list, once at a time per agent; resolves to the answer, never rejects. */
  ask(agentId: string): Promise<AgentModelList> {
    const def = this.deps.defOf(agentId);
    if (!def) return Promise.resolve({ kind: 'error', reason: `no agent named ${agentId}` });
    const running = this.asking.get(def);
    if (running) return running;
    const p = this.probe(def).then((answer) => {
      this.known.set(def, answer);
      this.asking.delete(def);
      return answer;
    });
    this.asking.set(def, p);
    return p;
  }

  /** Start a session of the agent under an id no conversation has, read its selector, dispose it. */
  private async probe(def: AgentDef): Promise<AgentModelList> {
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
      const answer: AgentModelList =
        selector && selector.options.length > 0 ? { kind: 'list', options: selector.options } : { kind: 'none' };
      console.log(
        `[models] asked ${def.id} for its models: ${answer.kind === 'list' ? `${answer.options.length}` : 'none offered'} (${Date.now() - started}ms)`
      );
      return answer;
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown';
      console.warn(`[models] could not ask ${def.id} for its models: ${reason}`);
      return { kind: 'error', reason };
    } finally {
      if (session) this.deps.agents.dispose(sid);
      this.deps.forget(sid);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
