import { findAgent, type Config } from '../config/schema.js';
import type { AgentFactory } from './agent.js';
import { createAcpAgentFactory } from './agent-acp.js';
import { createAgyAgentFactory } from './agent-agy.js';
import { agyRuntime } from './agy-acp.js';
import type { ConversationStore } from './conversation-store.js';

/**
 * Agent-runtime dispatch: build one AgentFactory that routes each agent to the runtime speaking its
 * protocol.
 *
 * Every harness preset speaks ACP and is served by agent-acp.ts — `agy` too, through `agy acp`, since
 * 2026-11-06. The one exception is an agy agent whose `env` sets `TALKCODE_AGY_RUNTIME: stream-json`
 * (agy-acp.ts agyRuntime): it stays on agent-agy.ts, the runtime agy had before it spoke ACP, kept as
 * a fallback until every host has run the ACP one. Both implement the same AgentFactory contract,
 * which keeps everything above this file (SessionRegistry / TurnRunner / StreamBuffer / ToolRenderer)
 * protocol-agnostic.
 *
 * This lives in its own module rather than in agent.ts so the interface file stays dependency-free
 * (both runtimes import it, so putting the dispatch there would create an import cycle).
 */
export function createAgentFactory(cfg: Config, socketPath: string, store?: ConversationStore): AgentFactory {
  // Both runtimes are constructed up front (each is just a Map plus closures; children spawn lazily
  // on the first turn), so an unused one costs nothing. The stream-json one also wires agy's status
  // line at construction, as it always has: the operator's own interactive agy draws it, and
  // TALKCODE_NO_AGY_STATUSLINE still turns that off (agy-statusline.ts).
  const acp = createAcpAgentFactory(cfg, socketPath, store);
  const agy = createAgyAgentFactory(cfg, socketPath, store);

  return {
    // Looked up per call, not once: a config reload (daemon/config-reload.ts) can add an agent, or
    // move one between harnesses or runtimes, and the runtime that serves it has to follow. A session
    // that already exists is handed back from wherever it lives, though: a reload drops the sessions
    // of a changed agent (ConversationRegistry.respawnAgents) except the ones it deliberately leaves
    // on the old definition, and those must not gain a twin in the other runtime.
    getOrCreate: (sessionId, agentId) => {
      const existing = acp.peek(sessionId) ?? agy.peek(sessionId);
      if (existing) return existing;
      const def = findAgent(cfg, agentId);
      const streamJson = def?.harness === 'agy' && agyRuntime(def) === 'stream-json';
      return (streamJson ? agy : acp).getOrCreate(sessionId, agentId);
    },
    // Same reason dispose fans out: the caller holds a conversation key, not an agent id. Asking
    // both is cheap (two Map lookups) and at most one of them can hold that key — the runtimes are
    // partitioned by agent, and a conversation has exactly one agent at a time.
    peek: (sessionId) => acp.peek(sessionId) ?? agy.peek(sessionId),
    // Callers hold only a session key, not the agent id, and disposing a session a runtime never
    // created is a documented no-op — so fan out to both rather than tracking ownership here.
    dispose: (sessionId) => {
      acp.dispose(sessionId);
      agy.dispose(sessionId);
    },
  };
}
