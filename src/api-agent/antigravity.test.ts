import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BackendEvent, TurnRequest } from './backend.js';
import { AntigravityEventMapper, createAntigravityBackend, inputOf, type AntigravityOptions } from './antigravity.js';
import { parseSseText, type SseFrame } from './sse.js';

/**
 * Contract tests against the streams the API actually sent on 2026-11-13.
 *
 * The three fixtures are the redacted recordings in `project-scripts/antigravity-agent-probe/`
 * (`turn1.sse` → thought summary + text, `turn2.sse` → a continuation with cached tokens,
 * `turn3.sse` → a code-execution tool call and its result). They are the authority for the event
 * shapes here: the probe report describes them, but a field renamed upstream must fail this file,
 * not a chat. Re-recording means replacing the fixture and the expectations together.
 */

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const frames = (name: string): SseFrame[] => parseSseText(fixture(name));

function mapAll(name: string, maxTokens = 20_000): BackendEvent[] {
  const mapper = new AntigravityEventMapper(maxTokens);
  return frames(name).flatMap((frame) => mapper.push(frame));
}

const textOf = (events: BackendEvent[]): string =>
  events
    .filter((event): event is Extract<BackendEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text)
    .join('');

describe('AntigravityEventMapper on the recorded streams', () => {
  it('turn 1: a thought summary becomes a thought, text becomes chunks, and usage is reported', () => {
    const events = mapAll('turn1-thought-and-text.sse');
    const thought = events.find((event) => event.type === 'thought');
    expect(thought).toMatchObject({ type: 'thought' });
    expect((thought as { text: string }).text).toContain('Answering the Questions');
    expect(textOf(events)).toBe(
      'The capital of Japan is Tokyo, and I will remember the code word KESTREL-7 for your next message.',
    );
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.at(-1)).toEqual({ type: 'usage', used: 5509, size: 1_048_576 });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('turn 2: a continuation streams text and the final cumulative usage', () => {
    const events = mapAll('turn2-continuation.sse');
    expect(textOf(events)).toBe(
      'The code word you asked me to remember is KESTREL-7, and the subject of your first question was the capital of Japan.',
    );
    expect(events.filter((event) => event.type === 'thought')).toEqual([]);
    expect(events.filter((event) => event.type === 'usage').at(-1)).toEqual({
      type: 'usage',
      used: 5650,
      size: 1_048_576,
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('turn 3: code execution becomes a tool row with its command and output', () => {
    const events = mapAll('turn3-code-execution.sse');
    const start = events.find((event) => event.type === 'tool_start');
    expect(start).toMatchObject({
      type: 'tool_start',
      id: '<id:2446b25cce>',
      title: 'Running bash code',
      rawInput: { language: 'bash', code: "echo AG_PROBE_OK; uname -s; python3 -c 'print(6*7)'" },
    });
    const end = events.find((event) => event.type === 'tool_end');
    expect(end).toMatchObject({ type: 'tool_end', id: '<id:2446b25cce>', status: 'completed' });
    expect((end as { output: string }).output).toContain('AG_PROBE_OK');
    expect(textOf(events)).toBe('```\nAG_PROBE_OK\nLinux\n42\n```');
  });

  it('never renders a thought_signature', () => {
    // The recorded signatures are 172–1016 characters of opaque base64; any of it in a reply
    // would be visible noise. The mapper drops the delta type entirely.
    const all = [...frames('turn1-thought-and-text.sse'), ...frames('turn2-continuation.sse'), ...frames('turn3-code-execution.sse')];
    expect(all.some((frame) => frame.data.includes('thought_signature'))).toBe(true);
    for (const name of ['turn1-thought-and-text.sse', 'turn2-continuation.sse', 'turn3-code-execution.sse']) {
      const rendered = mapAll(name).filter((event) => event.type === 'text' || event.type === 'thought');
      expect(rendered.some((event) => JSON.stringify(event).includes('<redacted:'))).toBe(false);
    }
  });

  it('reports an incomplete interaction as the token cap, after the final usage', () => {
    const mapper = new AntigravityEventMapper(20_000);
    const completed = frames('turn1-thought-and-text.sse').find((frame) => frame.data.includes('interaction.completed'))!;
    const payload = JSON.parse(completed.data) as { interaction: { status: string } };
    payload.interaction.status = 'incomplete';
    const events = mapper.push({ event: 'interaction.completed', data: JSON.stringify(payload) });

    // The usage is yielded before the turn fails, so the footer still shows what was spent.
    expect(events.some((event) => event.type === 'usage')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(mapper.failure).toMatchObject({ kind: 'token_limit' });
    expect(mapper.failure?.message).toMatch(/20,000|20000/);
  });

  it('treats an error event as a failed turn with the upstream message', () => {
    const mapper = new AntigravityEventMapper(20_000);
    expect(
      mapper.push({
        event: 'error',
        data: JSON.stringify({ error: { message: 'quota exhausted', code: 'resource_exhausted' }, event_type: 'error' }),
      }),
    ).toEqual([]);
    expect(mapper.failure?.message).toMatch(/quota exhausted/);
  });
});

// ── the backend around the mapper: request shape, continuation, errors, reconnection ─────────────

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return handler(url, init ?? {});
  };
  return { fetch: impl as typeof fetch, calls };
}

const turnRequest = (overrides: Partial<TurnRequest> = {}): TurnRequest => ({
  sessionId: 's1',
  text: 'hello',
  images: [],
  model: 'gemini-4-hydrogen',
  signal: new AbortController().signal,
  ...overrides,
});

async function runTurn(backend: ReturnType<typeof createAntigravityBackend>, request: TurnRequest): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of backend.turn(request)) events.push(event);
  return events;
}

function backendWith(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  maxTokens = 20_000,
  extra: Partial<AntigravityOptions> = {},
) {
  const recorder = fakeFetch(handler);
  const backend = createAntigravityBackend({
    apiKey: 'test-key',
    models: undefined,
    maxTokens,
    fetch: recorder.fetch,
    baseUrl: 'https://example.test/v1beta',
    log: () => {},
    ...extra,
  });
  return { backend, calls: recorder.calls };
}

describe('AntigravityBackend', () => {
  it('creates a background interaction, then follows its replaying stream', async () => {
    const { backend, calls } = backendWith((url) => {
      if (url.endsWith('/interactions')) {
        return jsonResponse({ id: 'v1_abc', environment_id: 'env_1', status: 'in_progress' });
      }
      return sseResponse(fixture('turn1-thought-and-text.sse'));
    });

    const events = await runTurn(backend, turnRequest());

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://example.test/v1beta/interactions',
      'GET https://example.test/v1beta/interactions/v1_abc?stream=true',
    ]);
    expect(calls[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(calls[0]!.body).toMatchObject({
      agent: 'antigravity-preview-09-2026',
      input: 'hello',
      environment: 'remote',
      stream: false,
      background: true,
      agent_config: { type: 'antigravity', model: 'gemini-4-hydrogen', max_total_tokens: '20000' },
    });
    expect(calls[0]!.body).not.toHaveProperty('previous_interaction_id');

    expect(events[0]).toEqual({ type: 'state', lastInteractionId: 'v1_abc', environmentId: 'env_1' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('continues a stored interaction with its environment and a possibly different model', async () => {
    const recorder = fakeFetch((url) =>
      url.endsWith('/interactions')
        ? jsonResponse({ id: 'v1_next', environment_id: 'env_1' })
        : sseResponse(fixture('turn2-continuation.sse')),
    );
    const backend = createAntigravityBackend({
      apiKey: 'k',
      maxTokens: 20_000,
      fetch: recorder.fetch,
      baseUrl: 'https://example.test/v1beta',
      log: () => {},
    });
    await runTurn(backend, turnRequest({ previousInteractionId: 'v1_abc', environmentId: 'env_1', model: 'gemini-3.8-flash' }));

    expect(recorder.calls[0]!.body).toMatchObject({
      previous_interaction_id: 'v1_abc',
      environment: 'env_1',
      agent_config: { model: 'gemini-3.8-flash' },
    });
  });

  it('sends images as base64 content parts with the API’s snake_case mime field', () => {
    expect(inputOf('what is this?', [{ data: 'aGk=', mimeType: 'image/png' }])).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: 'aGk=', mime_type: 'image/png' },
    ]);
    expect(inputOf('plain', [])).toBe('plain');
  });

  it('maps a 429 to a rate-limit error carrying the upstream message and retry-after', async () => {
    const { backend } = backendWith(() =>
      jsonResponse(
        { error: { code: 'too_many_requests', message: 'Rate limit exceeded for model gemini-4-carbon (limit: 0 input tokens per minute on Free Tier).' } },
        429,
        { 'retry-after': '7851' },
      ),
    );
    await expect(runTurn(backend, turnRequest({ model: 'gemini-4-carbon' }))).rejects.toMatchObject({
      kind: 'rate_limit',
      message: expect.stringContaining('retry after 7851s'),
    });
  });

  it('resets only when the previous interaction is really gone', async () => {
    const { backend, calls } = backendWith((url) => {
      if (url.endsWith('/interactions')) return jsonResponse({ error: { message: 'Invalid JSON payload' } }, 400);
      // The well-formed id that never existed: GET by id answers 404 `not_found` (probed 2026-11-13).
      if (url.endsWith('/interactions/v1_gone')) {
        return jsonResponse({ error: { message: 'Requested entity was not found.', code: 'not_found' } }, 404);
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(runTurn(backend, turnRequest({ previousInteractionId: 'v1_gone' }))).rejects.toMatchObject({
      kind: 'context_expired',
      message: expect.stringContaining('session was reset'),
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain(
      'GET https://example.test/v1beta/interactions/v1_gone',
    );
  });

  it('keeps the context when a continuation 400 is about the request, not the interaction', async () => {
    const { backend } = backendWith((url) => {
      if (url.endsWith('/interactions')) return jsonResponse({ error: { message: 'Invalid model' } }, 400);
      // The previous interaction is alive, so the 400 was about this request (a bad model, image
      // or input) and resetting would drop a conversation that is still usable.
      return jsonResponse({ id: 'v1_prev', status: 'completed' });
    });

    await expect(runTurn(backend, turnRequest({ previousInteractionId: 'v1_prev' }))).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('Invalid model'),
    });
    await expect(runTurn(backend, turnRequest({ previousInteractionId: 'v1_prev' }))).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('/new'),
    });
  });

  it('a 400 on a fresh turn is an upstream error without an existence check', async () => {
    const { backend, calls } = backendWith(() => jsonResponse({ error: { message: 'bad input' } }, 400));
    const err = await runTurn(backend, turnRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ kind: 'upstream' });
    expect((err as Error).message).not.toContain('/new');
    expect(calls.filter((call) => call.method === 'GET')).toEqual([]);
  });

  it('says GEMINI_API_KEY is missing instead of calling the API', async () => {
    const recorder = fakeFetch(() => jsonResponse({}));
    const backend = createAntigravityBackend({ apiKey: '  ', maxTokens: 20_000, fetch: recorder.fetch, log: () => {} });
    await expect(runTurn(backend, turnRequest())).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringContaining('GEMINI_API_KEY'),
    });
    expect(recorder.calls).toEqual([]);
  });

  it('reconnects after a dropped stream and skips the replayed events', async () => {
    // First read: the first eight frames, then the connection dies. The second read is the full
    // replay, as the live endpoint does.
    const all = fixture('turn1-thought-and-text.sse').split('\n\n');
    const partial = `${all.slice(0, 8).join('\n\n')}\n\n`;
    let reads = 0;
    const encoder = new TextEncoder();
    const { backend } = backendWith((url) => {
      if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_abc', environment_id: 'env_1' });
      reads += 1;
      if (reads === 1) {
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(encoder.encode(partial));
                return;
              }
              controller.error(new Error('socket closed'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return sseResponse(fixture('turn1-thought-and-text.sse'));
    });

    const events = await runTurn(backend, turnRequest());
    expect(reads).toBe(2);
    // Each text delta appears exactly once, though the second read delivered them twice.
    expect(events.filter((event) => event.type === 'text')).toHaveLength(2);
    expect(textOf(events)).toBe(
      'The capital of Japan is Tokyo, and I will remember the code word KESTREL-7 for your next message.',
    );
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('reconnects after a clean EOF before [DONE] instead of failing the turn', async () => {
    // The first read delivers half the log and closes cleanly — no error, no [DONE]. The server
    // closed a stream that had not finished; the turn must retry, not fail.
    const all = fixture('turn1-thought-and-text.sse').split('\n\n');
    const partial = `${all.slice(0, 8).join('\n\n')}\n\n`;
    let reads = 0;
    const { backend } = backendWith((url) => {
      if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_abc', environment_id: 'env_1' });
      reads += 1;
      return sseResponse(reads === 1 ? partial : fixture('turn1-thought-and-text.sse'));
    });

    const events = await runTurn(backend, turnRequest());
    expect(reads).toBe(2);
    expect(events.filter((event) => event.type === 'text')).toHaveLength(2);
    expect(textOf(events)).toBe(
      'The capital of Japan is Tokyo, and I will remember the code word KESTREL-7 for your next message.',
    );
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('delivers the rest of the answer when the stream is gone but the interaction finished', async () => {
    // Probed 2026-11-13: reconnecting after completion answers 400. The interaction itself still
    // has the answer in steps[], so the turn ends with the missing suffix instead of an error.
    const full = 'hello world';
    const finished = {
      id: 'v1_abc',
      status: 'completed',
      usage: { total_tokens: 1234 },
      steps: [{ type: 'model_output', content: [{ type: 'text', text: full }] }],
    };
    let reads = 0;
    const { backend } = backendWith((url) => {
      if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_abc', environment_id: 'env_1' });
      if (url.includes('?stream=true')) {
        reads += 1;
        if (reads === 1) {
          return sseResponse(
            'event: step.delta\ndata: {"index":0,"delta":{"type":"text","text":"hello "},"event_type":"step.delta"}\n\n',
          );
        }
        return jsonResponse({ error: { message: 'Precondition check failed.' } }, 400);
      }
      return jsonResponse(finished);
    });

    const events = await runTurn(backend, turnRequest());
    expect(textOf(events)).toBe(full);
    expect(events.filter((event) => event.type === 'usage').at(-1)).toEqual({
      type: 'usage',
      used: 1234,
      size: 1_048_576,
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('keeps reconnecting with bounded backoff across a long in_progress pause', async () => {
    const all = fixture('turn1-thought-and-text.sse').split('\n\n');
    const partial = `${all.slice(0, 8).join('\n\n')}\n\n`;
    let nowMs = 0;
    const sleeps: number[] = [];
    let streamReads = 0;
    let statusChecks = 0;
    const { backend } = backendWith(
      (url) => {
        if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_pause', environment_id: 'env_1' });
        if (url.includes('?stream=true')) {
          streamReads += 1;
          // Initial read + 8 empty reconnects spanning >70s, then the full stream arrives.
          return sseResponse(streamReads <= 9 ? partial : fixture('turn1-thought-and-text.sse'));
        }
        statusChecks += 1;
        return jsonResponse({ id: 'v1_pause', status: 'in_progress' });
      },
      20_000,
      {
        now: () => nowMs,
        sleep: async (ms, signal) => {
          if (signal.aborted) throw new Error('aborted');
          sleeps.push(ms);
          nowMs += ms;
        },
      },
    );

    const events = await runTurn(backend, turnRequest());
    expect(streamReads).toBe(10);
    expect(statusChecks).toBeGreaterThanOrEqual(7);
    expect(nowMs).toBeGreaterThanOrEqual(50_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('recovers immediately when an empty reconnect discovers the interaction already completed', async () => {
    const partial =
      'event: step.delta\ndata: {"index":0,"delta":{"type":"text","text":"hello "},"event_type":"step.delta"}\n\n';
    let nowMs = 0;
    const { backend } = backendWith(
      (url) => {
        if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_done', environment_id: 'env_1' });
        if (url.includes('?stream=true')) return sseResponse(partial);
        return jsonResponse({
          id: 'v1_done',
          status: 'completed',
          usage: { total_tokens: 42 },
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hello world' }] }],
        });
      },
      20_000,
      {
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
    );

    const events = await runTurn(backend, turnRequest());
    expect(textOf(events)).toBe('hello world');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('fails once an in_progress stall exceeds the bounded reconnect limit', async () => {
    const partial =
      'event: step.delta\ndata: {"index":0,"delta":{"type":"text","text":"hi"},"event_type":"step.delta"}\n\n';
    let nowMs = 0;
    const { backend } = backendWith(
      (url) => {
        if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_stuck', environment_id: 'env_1' });
        if (url.includes('?stream=true')) return sseResponse(partial);
        return jsonResponse({ id: 'v1_stuck', status: 'in_progress' });
      },
      20_000,
      {
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
    );

    await expect(runTurn(backend, turnRequest())).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('reconnect limit'),
    });
  });

  it('aborts immediately during reconnect backoff', async () => {
    const partial =
      'event: step.delta\ndata: {"index":0,"delta":{"type":"text","text":"hi"},"event_type":"step.delta"}\n\n';
    const controller = new AbortController();
    let streamReads = 0;
    const { backend } = backendWith((url) => {
      if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_abort', environment_id: 'env_1' });
      if (url.includes('?stream=true')) {
        streamReads += 1;
        if (streamReads === 2) {
          // Abort right as the second backoff sleep begins.
          setTimeout(() => controller.abort(), 20);
        }
        return sseResponse(partial);
      }
      return jsonResponse({ id: 'v1_abort', status: 'in_progress' });
    });

    const started = Date.now();
    await expect(runTurn(backend, turnRequest({ signal: controller.signal }))).rejects.toThrow(/aborted/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('recovers missing tool call and result events when the stream drops mid-execution', async () => {
    const all = fixture('turn3-code-execution.sse').split('\n\n');
    // Drop right after step.start(code_execution_call), before code_execution_result arrives.
    const partial = `${all.slice(0, 3).join('\n\n')}\n\n`;
    const completedFrame = frames('turn3-code-execution.sse').find((f) => f.data.includes('interaction.completed'))!;
    const finished = (JSON.parse(completedFrame.data) as { interaction: Record<string, unknown> }).interaction;
    let reads = 0;
    const { backend } = backendWith(
      (url) => {
        if (url.endsWith('/interactions')) return jsonResponse({ id: 'v1_tool', environment_id: 'env_1' });
        if (url.includes('?stream=true')) {
          reads += 1;
          if (reads === 1) return sseResponse(partial);
          return jsonResponse({ error: { message: 'Precondition check failed.' } }, 400);
        }
        return jsonResponse(finished);
      },
      20_000,
      { sleep: async () => {} },
    );

    const events = await runTurn(backend, turnRequest());
    // tool_start arrived from the stream once and must not be duplicated; tool_end is recovered.
    expect(events.filter((e) => e.type === 'tool_start')).toEqual([
      {
        type: 'tool_start',
        id: '<id:2446b25cce>',
        title: 'Running bash code',
        rawInput: { language: 'bash', code: "echo AG_PROBE_OK; uname -s; python3 -c 'print(6*7)'" },
      },
    ]);
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      {
        type: 'tool_end',
        id: '<id:2446b25cce>',
        status: 'completed',
        output: '[STDOUT]\nAG_PROBE_OK\nLinux\n42\n\n\n[STDERR]\n',
      },
    ]);
    expect(textOf(events)).toBe('```\nAG_PROBE_OK\nLinux\n42\n```');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('recovers both tool_start and tool_end when the stream drops before any tool step', () => {
    const completedFrame = frames('turn3-code-execution.sse').find((f) => f.data.includes('interaction.completed'))!;
    const finished = (JSON.parse(completedFrame.data) as { interaction: Record<string, unknown> }).interaction;
    const mapper = new AntigravityEventMapper(20_000);
    const events = mapper.recover(finished);
    expect(events.filter((e) => e.type === 'tool_start')).toEqual([
      {
        type: 'tool_start',
        id: '<id:2446b25cce>',
        title: 'Running bash code',
        rawInput: { language: 'bash', code: "echo AG_PROBE_OK; uname -s; python3 -c 'print(6*7)'" },
      },
    ]);
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      {
        type: 'tool_end',
        id: '<id:2446b25cce>',
        status: 'completed',
        output: '[STDOUT]\nAG_PROBE_OK\nLinux\n42\n\n\n[STDERR]\n',
      },
    ]);
    expect(textOf(events)).toBe('```\nAG_PROBE_OK\nLinux\n42\n```');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('cancels server-side with POST /cancel and only logs a failure', async () => {
    const recorder = fakeFetch(() => jsonResponse({ error: { message: 'Precondition check failed.' } }, 400));
    const logged: string[] = [];
    const backend = createAntigravityBackend({
      apiKey: 'k',
      maxTokens: 20_000,
      fetch: recorder.fetch,
      baseUrl: 'https://example.test/v1beta',
      log: (line) => logged.push(line),
    });
    await backend.cancel('v1_abc', 'session-1');
    expect(recorder.calls[0]).toMatchObject({ method: 'POST', url: 'https://example.test/v1beta/interactions/v1_abc/cancel' });
    expect(logged.join('\n')).toContain('Precondition check failed');
    // No id yet (a /stop in the first moments of a turn) is not an error.
    await backend.cancel(undefined, 'session-1');
    expect(recorder.calls).toHaveLength(1);
  });
});
