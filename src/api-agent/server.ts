/**
 * The generic half: an ACP agent whose turns are HTTP API calls.
 *
 * The daemon is an ACP *client*; `harness: custom` spawns any executable and speaks the protocol
 * to it over stdio. This module is the other end of that pipe, and it exists so a service with an
 * HTTP API can be an agent without the daemon learning anything about it. It handles the six
 * methods the gateway actually uses (probed 2026-11-13, `acp-chat-shim-smoke`):
 *
 *   initialize · session/new · session/load · session/prompt · session/cancel
 *   · session/set_config_option (only because the model menu exists)
 *
 * `session/update` is the only thing it sends. There are no permission requests and no
 * elicitation: this agent runs no local tools, so there is nothing to ask about. `mcpServers`
 * from `session/new` is ignored for the same reason — the gateway's `send_file`/`schedule` tools
 * are not reachable from a cloud sandbox.
 *
 * What the daemon expects, in the places this file is easy to get wrong:
 * - A cancelled turn must still **resolve** its `session/prompt`, with `stopReason: "cancelled"`.
 *   The gateway waits on the response, not on the notification (prompt-turn.md).
 * - A failed turn is a **rejected** prompt: the daemon renders `❌ This turn failed: <message>`
 *   and keeps whatever text already streamed. That is why errors here are written as sentences.
 * - `session/load` must not replay history as updates: the gateway drops updates before the
 *   first prompt precisely because a resumed session may replay (daemon/README.md, "Replayed
 *   history is not output"). This agent stores ids, not text, so there is nothing to replay.
 */
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type SessionConfigOption,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import {
  ApiAgentError,
  type ApiBackend,
  type BackendEvent,
  type ModelOption,
  type PromptImage,
} from './backend.js';
import type { SessionRecord, SessionStore } from './store.js';

export interface ApiAgentServerOptions {
  backend: ApiBackend;
  store: SessionStore;
  /** The models to report in `configOptions`, after `--models`. */
  models: readonly ModelOption[];
  /** Diagnostics go to stderr; stdout is the JSON-RPC transport and nothing else. */
  log?: (line: string) => void;
}

interface ActiveTurn {
  controller: AbortController;
  /** Known only after the backend's `state` event; `/cancel` needs it. */
  interactionId?: string;
}

/**
 * Build the ACP app. Separated from `serveApiAgent` so tests can connect a real ACP client to it
 * in-process (`ClientApp.connectWith(agentApp, …)`) without a subprocess or a pipe.
 */
export function createApiAgentApp(options: ApiAgentServerOptions): AgentApp {
  const { backend, store, models } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const active = new Map<string, ActiveTurn>();

  const modelOption = (current: string): SessionConfigOption => ({
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: models.map((model) => ({ value: model.value, name: model.name })),
  });

  /** A session the gateway never created (or one whose record was pruned) starts empty. */
  const ensure = (sessionId: string): SessionRecord =>
    store.get(sessionId) ?? store.put({ sessionId, model: backend.defaultModel });

  const notify = (client: AgentContext, sessionId: string, update: SessionUpdate): Promise<void> =>
    client.notify('session/update', { sessionId, update });

  const app = agent({ name: `fleetherd api-agent (${backend.id})` })
    .onRequest('initialize', ({ params }) => {
      log(`[api-agent] initialize: client protocol ${params.protocolVersion}`);
      // loadSession is what lets the gateway reclaim an idle child and resume it later; without
      // it, a spawned process is never reclaimed (smoke report §2.6). Image prompts are declared
      // because the backend forwards them inline; if the API rejects them, the turn says so.
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      };
    })
    .onRequest('session/new', () => {
      const sessionId = randomUUID();
      const record = store.put({ sessionId, model: backend.defaultModel });
      log(`[api-agent] session/new ${sessionId} (model ${record.model})`);
      return { sessionId, configOptions: [modelOption(record.model ?? backend.defaultModel)] };
    })
    .onRequest('session/load', ({ params }) => {
      const existing = store.get(params.sessionId);
      const record = existing ?? store.put({ sessionId: params.sessionId, model: backend.defaultModel });
      if (!existing) {
        log(`[api-agent] session/load ${params.sessionId}: no stored context, starting it empty`);
      }
      return { configOptions: [modelOption(record.model ?? backend.defaultModel)] };
    })
    .onRequest('session/set_config_option', ({ params }) => {
      const value = typeof params.value === 'string' ? params.value : '';
      if (params.configId !== 'model') throw userError(new Error(`unknown session config option "${params.configId}"`));
      if (!models.some((model) => model.value === value)) throw userError(new Error(`unknown model "${value}"`));
      const record = ensure(params.sessionId);
      store.put({
        sessionId: params.sessionId,
        model: value,
        lastInteractionId: record.lastInteractionId,
        environmentId: record.environmentId,
      });
      log(`[api-agent] ${params.sessionId}: model -> ${value}`);
      // The response is the update: ACP's set_config_option answers with the full option set,
      // which is what the gateway's `/model` display follows (agent-acp.ts setModel).
      return { configOptions: [modelOption(value)] };
    })
    .onRequest('session/prompt', async ({ params, client, signal }) => {
      if (active.has(params.sessionId)) {
        throw userError(new Error('a turn is already running in this session; wait for it or /stop it'));
      }
      const turn: ActiveTurn = { controller: new AbortController() };
      active.set(params.sessionId, turn);
      // Two ways to stop: the client's session/cancel (our controller) and the connection going
      // away (the SDK's signal). The backend sees one signal, already combined.
      const combined = AbortSignal.any([signal, turn.controller.signal]);
      const record = ensure(params.sessionId);
      try {
        const events = backend.turn({
          sessionId: params.sessionId,
          text: textOf(params.prompt),
          images: imagesOf(params.prompt),
          model: record.model ?? backend.defaultModel,
          previousInteractionId: record.lastInteractionId,
          environmentId: record.environmentId,
          signal: combined,
        });
        for await (const event of events) {
          if (event.type === 'state') {
            turn.interactionId = event.lastInteractionId ?? turn.interactionId;
            // The environment is safe to keep at once: it is the sandbox, not the conversation.
            // The interaction id is not — it becomes the next turn's continuation point only if
            // this turn finishes. A /stop must not leave the following message pointing at an
            // interaction whose answer the user never saw.
            //
            // Only the field learned is written: the turn's snapshot may be stale if /model
            // changed the session while this one was running (store.patch says why).
            if (event.environmentId) store.patch(params.sessionId, { environmentId: event.environmentId });
            continue;
          }
          if (event.type === 'done') {
            if (turn.interactionId) store.patch(params.sessionId, { lastInteractionId: turn.interactionId });
            continue;
          }
          await notify(client, params.sessionId, toUpdate(event));
        }
        return { stopReason: 'end_turn' as const };
      } catch (err) {
        if (combined.aborted) return { stopReason: 'cancelled' as const };
        if (err instanceof ApiAgentError && err.kind === 'context_expired') {
          // The next turn must start a new interaction rather than fail the same way again.
          store.clearContext(params.sessionId);
        }
        if (err instanceof ApiAgentError && err.kind === 'token_limit' && turn.interactionId) {
          // The cap is a terminal answer, not a lost turn: the partial reply was delivered, so
          // the next message should continue from it rather than from two turns ago.
          store.patch(params.sessionId, { lastInteractionId: turn.interactionId });
        }
        throw userError(err);
      } finally {
        active.delete(params.sessionId);
      }
    })
    .onNotification('session/cancel', ({ params }) => {
      const turn = active.get(params.sessionId);
      if (!turn) return;
      // Stop the local turn first: the user asked to stop, and the upstream call is best-effort.
      turn.controller.abort();
      void backend.cancel(turn.interactionId).catch((err: unknown) => {
        log(`[api-agent] cancel failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

  return app;
}

/** Serve over stdio until the daemon closes the pipe. */
export async function serveApiAgent(options: ApiAgentServerOptions): Promise<void> {
  const app = createApiAgentApp(options);
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  await connection.closed;
}

/**
 * The prompt's text: the text blocks joined. The gateway sends exactly one, containing the user's
 * message plus the paths of any non-image attachments (it adds no preamble of its own).
 */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The prompt's images, in the order the client sent them (pictures first, then the text). */
export function imagesOf(blocks: readonly ContentBlock[]): PromptImage[] {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
    .map((block) => ({ data: block.data, mimeType: block.mimeType }));
}

/**
 * An error the daemon will show as written.
 *
 * The SDK converts anything that is not a `RequestError` into a bare "Internal error" on the
 * wire, which would throw away the only sentence the user gets. So every rejection that leaves a
 * handler is wrapped here, with the backend's `kind` kept in `data` for anyone reading the frame.
 */
function userError(err: unknown): RequestError {
  const message = err instanceof Error ? err.message : String(err);
  const data = err instanceof ApiAgentError ? { kind: err.kind } : undefined;
  return new RequestError(-32603, message, data);
}

/**
 * A backend event as an ACP update.
 *
 * `thought` becomes `agent_thought_chunk`, which the gateway records but keeps out of the reply
 * body — that is exactly what a reasoning summary should do. Tool rows use `kind: 'execute'`
 * because the only tool the backend exposes is its own sandbox's code execution.
 */
function toUpdate(event: Exclude<BackendEvent, { type: 'state' | 'done' }>): SessionUpdate {
  switch (event.type) {
    case 'text':
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } };
    case 'thought':
      return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } };
    case 'tool_start':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.id,
        title: event.title,
        kind: 'execute',
        status: 'in_progress',
        rawInput: event.rawInput,
      };
    case 'tool_end':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: event.status,
        content: event.output
          ? [{ type: 'content', content: { type: 'text', text: event.output } }]
          : undefined,
        rawOutput: event.output === undefined ? undefined : { result: event.output },
      };
    case 'usage':
      return { sessionUpdate: 'usage_update', used: event.used, size: event.size };
  }
}
