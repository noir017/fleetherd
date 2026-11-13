import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { client, PROTOCOL_VERSION, type ClientContext, type SessionUpdate } from '@agentclientprotocol/sdk';
import { ApiAgentError, type ApiBackend, type BackendEvent, type TurnRequest } from './backend.js';
import { createApiAgentApp } from './server.js';
import { SessionStore } from './store.js';
import { ANTIGRAVITY_MODELS } from './antigravity.js';

/**
 * The server driven by a real ACP client, in-process.
 *
 * `@agentclientprotocol/sdk` can connect a `ClientApp` to an `AgentApp` without a pipe, which is
 * the same handler code the daemon reaches over stdio but with the wire removed — so these tests
 * pin what the daemon actually sends and reads: the capability handshake, `session/new`'s
 * `configOptions`, `session/update` shapes, the prompt response's `stopReason`, and that a cancel
 * resolves the turn rather than leaving it hanging. A fake backend keeps the HTTP side out.
 */

const dirs: string[] = [];
function newStore(): SessionStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-agent-server-'));
  dirs.push(dir);
  return new SessionStore({ dir: path.join(dir, 'api-agent', 'antigravity'), log: () => {} });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeBackend extends ApiBackend {
  requests: TurnRequest[];
  cancelled: (string | undefined)[];
}

function fakeBackend(handler: (request: TurnRequest) => AsyncGenerator<BackendEvent>): FakeBackend {
  const requests: TurnRequest[] = [];
  const cancelled: (string | undefined)[] = [];
  return {
    id: 'antigravity',
    defaultModel: 'gemini-4-hydrogen',
    models: ANTIGRAVITY_MODELS,
    requests,
    cancelled,
    async *turn(request) {
      requests.push(request);
      yield* handler(request);
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };
}

/** Run a client workflow against a fresh app; returns the updates it was sent. */
async function withClient<T>(
  backend: ApiBackend,
  store: SessionStore,
  work: (ctx: ClientContext, updates: SessionUpdate[]) => Promise<T>,
): Promise<T> {
  const app = createApiAgentApp({ backend, store, models: backend.models, log: () => {} });
  const updates: SessionUpdate[] = [];
  const acp = client({ name: 'test-client' }).onNotification('session/update', ({ params }) => {
    updates.push(params.update);
  });
  return acp.connectWith(app, (ctx) => work(ctx, updates));
}

const promptOf = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });

describe('createApiAgentApp', () => {
  it('declares loadSession and image prompts', async () => {
    const backend = fakeBackend(async function* () {});
    const response = await withClient(backend, newStore(), (ctx) =>
      ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION }),
    );
    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentCapabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: true } });
  });

  it('session/new returns a session id and the model menu, with hydrogen selected', async () => {
    const backend = fakeBackend(async function* () {});
    const store = newStore();
    const response = await withClient(backend, store, (ctx) =>
      ctx.request('session/new', { cwd: '/tmp', mcpServers: [] }),
    );

    expect(response.sessionId).toBeTruthy();
    expect(response.configOptions).toHaveLength(1);
    expect(response.configOptions![0]).toMatchObject({
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-4-hydrogen',
    });
    expect((response.configOptions![0] as { options: unknown[] }).options).toHaveLength(6);
    expect(store.get(response.sessionId)?.model).toBe('gemini-4-hydrogen');
  });

  it('streams text, thought, tool rows and usage, and ends with end_turn', async () => {
    const backend = fakeBackend(async function* () {
      yield { type: 'state', lastInteractionId: 'v1_a', environmentId: 'env_a' };
      yield { type: 'thought', text: 'thinking' };
      yield { type: 'text', text: 'hello ' };
      yield { type: 'text', text: 'world' };
      yield { type: 'tool_start', id: 't1', title: 'Running bash code', rawInput: { code: 'echo hi' } };
      yield { type: 'tool_end', id: 't1', status: 'completed', output: 'hi' };
      yield { type: 'usage', used: 1234, size: 1_048_576 };
      yield { type: 'done' };
    });
    const store = newStore();

    const result = await withClient(backend, store, async (ctx, updates) => {
      const session = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      const response = await ctx.request('session/prompt', { sessionId: session.sessionId, prompt: [promptOf('hi')] });
      return { session, response, updates };
    });

    expect(result.response).toEqual({ stopReason: 'end_turn' });
    expect(result.updates).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Running bash code',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { code: 'echo hi' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
        rawOutput: { result: 'hi' },
      },
      { sessionUpdate: 'usage_update', used: 1234, size: 1_048_576 },
    ]);
    // The ids from the state event are on disk before the turn ends.
    expect(store.get(result.session.sessionId)).toMatchObject({
      lastInteractionId: 'v1_a',
      environmentId: 'env_a',
    });
  });

  it('passes the stored ids and the selected model into the next turn', async () => {
    const backend = fakeBackend(async function* () {
      yield { type: 'state', lastInteractionId: 'v1_b', environmentId: 'env_a' };
      yield { type: 'done' };
    });
    const store = newStore();
    store.put({ sessionId: 's1', model: 'gemini-3.8-flash', lastInteractionId: 'v1_a', environmentId: 'env_a' });

    await withClient(backend, store, (ctx) =>
      ctx.request('session/prompt', { sessionId: 's1', prompt: [promptOf('again')] }),
    );

    expect(backend.requests[0]).toMatchObject({
      sessionId: 's1',
      text: 'again',
      model: 'gemini-3.8-flash',
      previousInteractionId: 'v1_a',
      environmentId: 'env_a',
    });
  });

  it('keeps a model that /model changed while the turn was running', async () => {
    const store = newStore();
    const backend = fakeBackend(async function* () {
      yield { type: 'state', lastInteractionId: 'v1_a' };
      // The person switched models mid-turn; the turn's own snapshot still says hydrogen.
      store.put({ sessionId: 's1', model: 'gemini-3.8-flash', lastInteractionId: 'v1_old' });
      yield { type: 'done' };
    });
    store.put({ sessionId: 's1', model: 'gemini-4-hydrogen', lastInteractionId: 'v1_old' });

    await withClient(backend, store, (ctx) =>
      ctx.request('session/prompt', { sessionId: 's1', prompt: [promptOf('go')] }),
    );

    expect(store.get('s1')).toMatchObject({ model: 'gemini-3.8-flash', lastInteractionId: 'v1_a' });
  });

  it('session/cancel aborts the turn, answers cancelled, and asks the backend to cancel', async () => {
    const backend = fakeBackend(async function* (request) {
      yield { type: 'state', lastInteractionId: 'v1_c' };
      yield { type: 'text', text: 'started' };
      await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const store = newStore();

    const response = await withClient(backend, store, async (ctx, updates) => {
      const session = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      // session/new makes a new session; give it the previous turn's state instead.
      store.put({ sessionId: session.sessionId, lastInteractionId: 'v1_old', environmentId: 'env_old' });
      const pending = ctx.request('session/prompt', { sessionId: session.sessionId, prompt: [promptOf('long')] });
      // The text update proves the server got past the state event, so the interaction id is
      // known and there is something for /cancel to name.
      while (!updates.some((update) => update.sessionUpdate === 'agent_message_chunk')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await ctx.notify('session/cancel', { sessionId: session.sessionId });
      return { pending, sessionId: session.sessionId };
    });

    expect(await response.pending).toEqual({ stopReason: 'cancelled' });
    expect(backend.cancelled).toEqual(['v1_c']);
    // A stopped turn is not a context: the next message continues from the last finished one.
    expect(store.get(response.sessionId)?.lastInteractionId).toBe('v1_old');
  });

  it('a turn that fails says why, and an expired context also resets the stored ids', async () => {
    const backend = fakeBackend(async function* () {
      throw new ApiAgentError('context expired: the upstream interaction is gone; the session was reset', 'context_expired');
    });
    const store = newStore();
    store.put({ sessionId: 's1', model: 'gemini-4-hydrogen', lastInteractionId: 'v1_old', environmentId: 'env_old' });

    await expect(
      withClient(backend, store, (ctx) =>
        ctx.request('session/prompt', { sessionId: 's1', prompt: [promptOf('hi')] }),
      ),
    ).rejects.toThrow(/context expired/);

    // The model survives; the ids do not, so the next turn starts a new interaction.
    expect(store.get('s1')).toMatchObject({ model: 'gemini-4-hydrogen' });
    expect(store.get('s1')?.lastInteractionId).toBeUndefined();
    expect(store.get('s1')?.environmentId).toBeUndefined();
  });

  it('session/load restores the model menu from disk without replaying history', async () => {
    const backend = fakeBackend(async function* () {});
    const store = newStore();
    store.put({ sessionId: 'kept', model: 'gemini-3.6-flash', lastInteractionId: 'v1_a', environmentId: 'env_a' });

    const response = await withClient(backend, store, (ctx) =>
      ctx.request('session/load', { sessionId: 'kept', cwd: '/tmp', mcpServers: [] }),
    );

    expect(response.configOptions![0]).toMatchObject({ id: 'model', currentValue: 'gemini-3.6-flash' });
  });

  it('session/set_config_option switches the model for later turns and refuses unknown values', async () => {
    const backend = fakeBackend(async function* () {
      yield { type: 'done' };
    });
    const store = newStore();

    const switched = await withClient(backend, store, async (ctx) => {
      const session = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      const response = await ctx.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: 'gemini-3.5-flash-lite',
      });
      await ctx.request('session/prompt', { sessionId: session.sessionId, prompt: [promptOf('next')] });
      return response;
    });

    expect(switched.configOptions[0]).toMatchObject({ id: 'model', currentValue: 'gemini-3.5-flash-lite' });
    expect(backend.requests.at(-1)?.model).toBe('gemini-3.5-flash-lite');

    await expect(
      withClient(backend, store, async (ctx) => {
        const session = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
        return ctx.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'not-a-model',
        });
      }),
    ).rejects.toThrow(/unknown model/);
  });
});
