import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import { promptUndelivered, type AgentSession, type AgentStreamHandlers } from './agent.js';
import { createAcpAgentFactory } from './agent-acp.js';
import { canPickUp, readResumeSupport, Redialer } from './agent-reconnect.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

describe('what an agent declares about picking a turn up', () => {
  it('reads reconnectTurn and promptId under _meta.fleetherd, and nothing else', () => {
    expect(readResumeSupport({ _meta: { fleetherd: { reconnectTurn: true, promptId: true } } })).toEqual({ reconnect: true, promptId: true });
    expect(readResumeSupport({ _meta: { fleetherd: { reconnectTurn: true } } })).toEqual({ reconnect: true, promptId: false });
    expect(readResumeSupport({ _meta: { other: { promptId: true } } })).toEqual({ reconnect: false, promptId: false });
    expect(readResumeSupport(undefined)).toEqual({ reconnect: false, promptId: false });
  });

  it('picks a turn up when the agent can say whether it took the prompt, or once reply text came', () => {
    expect(canPickUp({ reconnect: true, promptId: true }, false)).toBe(true);
    // Without promptId a queued turn cannot be told from a running one until it shows text.
    expect(canPickUp({ reconnect: true, promptId: false }, false)).toBe(false);
    expect(canPickUp({ reconnect: true, promptId: false }, true)).toBe(true);
    expect(canPickUp({ reconnect: false, promptId: false }, true)).toBe(false);
  });
});

describe('the waits between tries', () => {
  afterEach(() => vi.useRealTimers());

  it('backs off within the window, says nothing about a blip, and tells the chat about a longer outage once', async () => {
    vi.useFakeTimers();
    let now = 0;
    const waits: number[] = [];
    const notices: string[] = [];
    const redial = new Redialer({
      agent: 'web',
      notice: (t) => notices.push(t),
      windowMs: 30_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
        vi.advanceTimersByTime(ms);
      },
    });
    const signal = new AbortController().signal;
    expect(await redial.next(signal, 'turn')).toBe(true);
    expect(await redial.next(signal, 'turn')).toBe(true);
    expect(notices).toEqual([]);
    redial.back();
    expect(notices).toEqual([]);

    while (await redial.next(signal, 'turn'));
    expect(waits).toEqual([1_000, 2_000, 1_000, 2_000, 4_000, 8_000, 15_000]);
    expect(notices).toEqual(['⚠️ Lost the connection to web; reconnecting for up to 1 minute. Its reply follows once it is back.']);
  });

  it('says it is back only when it said it was gone, and stops waiting on a /stop', async () => {
    vi.useFakeTimers();
    let now = 0;
    const notices: string[] = [];
    const redial = new Redialer({ agent: 'web', notice: (t) => notices.push(t), now: () => now, sleep: async (ms) => void (now += ms) });
    const stop = new AbortController();
    await redial.next(stop.signal, 'start');
    vi.advanceTimersByTime(10_000);
    redial.back();
    expect(notices).toEqual([
      '⚠️ Cannot reach web; trying again for up to 2 minutes. The message goes out once it answers.',
      '✅ Reconnected to web.',
    ]);
    stop.abort();
    expect(await redial.next(stop.signal, 'start')).toBe(false);
  });
});

// ── A connect agent that goes away mid-turn and comes back ───────────────────────────────────────

interface Heard {
  text: string;
  promptId?: string;
  reconnect?: boolean;
}

interface Reply {
  text(t: string): void;
  tool(title: string): void;
  end(): void;
  error(message: string, data?: unknown): void;
}

/** An ACP service on a fixed port: it can drop its connections, or stop listening and start again. */
class FlakyAgent {
  port = 0;
  readonly methods: string[] = [];
  readonly prompts: Heard[] = [];
  connections = 0;
  private srv: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly caps: Record<string, unknown>,
    private readonly onPrompt: (p: Heard, reply: Reply, n: number) => void
  ) {}

  async up(): Promise<void> {
    const srv = net.createServer((s) => this.serve(s));
    await new Promise<void>((r) => srv.listen(this.port, '127.0.0.1', r));
    this.port = (srv.address() as net.AddressInfo).port;
    this.srv = srv;
  }

  /** The service went away: refused until `up()`. */
  async down(): Promise<void> {
    this.drop();
    const srv = this.srv;
    this.srv = undefined;
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }

  /** Every connection reset, the service still listening. */
  drop(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  private serve(s: net.Socket): void {
    this.connections++;
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
    const send = (o: object): void => void (s.destroyed || s.write(`${JSON.stringify(o)}\n`));
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; method?: string; params?: Record<string, unknown> };
        buf = buf.slice(nl + 1);
        if (msg.method) this.methods.push(msg.method);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: this.caps } });
        } else if (msg.method === 'session/new') {
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
        } else if (msg.method === 'session/load') {
          send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const blocks = (msg.params?.['prompt'] ?? []) as Array<{ text?: string; _meta?: { fleetherd?: { promptId?: string; reconnect?: boolean } } }>;
          const f = blocks.at(-1)?._meta?.fleetherd;
          const heard: Heard = { text: blocks.map((b) => b.text ?? '').join(''), ...(f?.promptId ? { promptId: f.promptId } : {}), ...(f?.reconnect ? { reconnect: true } : {}) };
          this.prompts.push(heard);
          const update = (u: object): void => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: u } });
          this.onPrompt(heard, {
            text: (t) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }),
            tool: (title) => update({ sessionUpdate: 'tool_call', toolCallId: `t${this.prompts.length}`, title, kind: 'other', status: 'in_progress' }),
            end: () => send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }),
            error: (message, data) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message, ...(data ? { data } : {}) } }),
          }, this.prompts.length);
        }
      }
    });
  }
}

const TAKES_ONCE = { loadSession: true, _meta: { fleetherd: { reconnectTurn: true, promptId: true } } };
const RECONNECT_ONLY = { loadSession: true, _meta: { fleetherd: { reconnectTurn: true } } };

describe('a connect agent whose connection goes away', () => {
  const agents: FlakyAgent[] = [];
  let live: AgentSession | undefined;
  afterEach(async () => {
    live?.dispose();
    live = undefined;
    for (const a of agents.splice(0)) await a.down();
  });

  async function agentOf(caps: Record<string, unknown>, onPrompt: (p: Heard, reply: Reply, n: number) => void): Promise<FlakyAgent> {
    const agent = new FlakyAgent(caps, onPrompt);
    agents.push(agent);
    await agent.up();
    return agent;
  }

  function sessionOn(agent: FlakyAgent, timing = { windowMs: 5_000, delaysMs: [100] }): AgentSession {
    const dir = makeTempDir('fh-reconnect-');
    const cfg: Config = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'web', harness: 'custom', cwd: dir, connect: { url: `tcp://127.0.0.1:${agent.port}` } }],
      routing: { default: 'web', pipeline: [] },
    });
    const sessions = new Map<string, string>();
    const store = {
      agentSession: (c: string, a: string) => sessions.get(`${c}/${a}`),
      setAgentSession: (c: string, a: string, s: string) => void sessions.set(`${c}/${a}`, s),
      conversationCwd: () => undefined,
      conversationChoice: () => undefined,
    } as unknown as Parameters<typeof createAcpAgentFactory>[2];
    live = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store, undefined, timing).getOrCreate('conv#1', 'web');
    return live;
  }

  function recorder(): { handlers: AgentStreamHandlers; text: () => string; notices: string[] } {
    let text = '';
    const notices: string[] = [];
    return {
      handlers: { onText: (d) => (text += d), onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {}, onNotice: (t) => notices.push(t) },
      text: () => text,
      notices,
    };
  }

  it('waits out a restart mid-turn, loads the session, and picks the turn up without sending the message again', async () => {
    const agent = await agentOf(TAKES_ONCE, (p, reply) => {
      if (p.reconnect) {
        reply.text('part two');
        reply.end();
        return;
      }
      reply.text('part one\n');
      // The service restarts: connections reset, refused for a while, then back.
      setTimeout(() => void agent.down().then(() => setTimeout(() => void agent.up(), 600)), 50);
    });
    const session = sessionOn(agent);
    const out = recorder();
    await session.runTurn({ prompt: 'deploy it', sessionToken: 'tok', promptId: 'pid-1' }, out.handlers);

    expect(out.text()).toBe('part one\npart two');
    expect(agent.prompts).toEqual([{ text: 'deploy it', promptId: 'pid-1' }, { text: '', promptId: 'pid-1', reconnect: true }]);
    expect(agent.methods).toEqual(['initialize', 'session/new', 'session/prompt', 'initialize', 'session/load', 'session/prompt']);
    expect(out.notices).toEqual([]);
  });

  it('sends the message, under the same id, only once the agent says it never took it', async () => {
    const agent = await agentOf(TAKES_ONCE, (p, reply, n) => {
      if (n === 1) {
        reply.tool('Waiting for a free slot (2 ahead)');
        setTimeout(() => agent.drop(), 50);
      } else if (p.reconnect) {
        reply.error('This message never reached the page', { notSent: true });
      } else {
        reply.text('done');
        reply.end();
      }
    });
    const out = recorder();
    await sessionOn(agent).runTurn({ prompt: 'deploy it', sessionToken: 'tok', promptId: 'pid-2' }, out.handlers);

    expect(out.text()).toBe('done');
    expect(agent.prompts).toEqual([
      { text: 'deploy it', promptId: 'pid-2' },
      { text: '', promptId: 'pid-2', reconnect: true },
      { text: 'deploy it', promptId: 'pid-2' },
    ]);
  });

  it('dials again until the agent answers, and sends the message once', async () => {
    const agent = await agentOf(TAKES_ONCE, (_p, reply) => {
      reply.text('hello');
      reply.end();
    });
    await agent.down();
    setTimeout(() => void agent.up(), 400);
    const out = recorder();
    await sessionOn(agent).runTurn({ prompt: 'hi', sessionToken: 'tok', promptId: 'pid-3' }, out.handlers);
    expect(out.text()).toBe('hello');
    expect(agent.prompts).toEqual([{ text: 'hi', promptId: 'pid-3' }]);
  });

  it('fails the turn as before once the window is over, without sending the message again', async () => {
    const agent = await agentOf(TAKES_ONCE, (_p, reply) => {
      reply.text('part one\n');
      setTimeout(() => void agent.down(), 50);
    });
    const out = recorder();
    const err = await sessionOn(agent, { windowMs: 600, delaysMs: [100] })
      .runTurn({ prompt: 'deploy it', sessionToken: 'tok', promptId: 'pid-4' }, out.handlers)
      .then(() => undefined, (e: unknown) => e);
    expect(String(err)).toMatch(/agent "web" lost its connection mid-turn and could not get it back: .*\(tried again for [1-9]\d*s\)/);
    expect(promptUndelivered(err)).toBe(false);
    expect(agent.prompts).toHaveLength(1);
  });

  it('says a message it could not deliver was not delivered, once the window is over', async () => {
    const agent = await agentOf(TAKES_ONCE, () => {});
    await agent.down();
    const err = await sessionOn(agent, { windowMs: 400, delaysMs: [100] })
      .runTurn({ prompt: 'hi', sessionToken: 'tok' }, recorder().handlers)
      .then(() => undefined, (e: unknown) => e);
    expect(String(err)).toMatch(/could not start: .*\(tried again for \d+s\)/);
    expect(promptUndelivered(err)).toBe(true);
  });

  it('ends quietly on a /stop while it waits', async () => {
    const agent = await agentOf(TAKES_ONCE, () => {});
    await agent.down();
    const session = sessionOn(agent, { windowMs: 60_000, delaysMs: [100] });
    setTimeout(() => session.abort(), 300);
    const started = Date.now();
    await session.runTurn({ prompt: 'hi', sessionToken: 'tok' }, recorder().handlers);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(agent.prompts).toEqual([]);
  });

  it('with reconnectTurn alone, picks a turn up only once it showed reply text', async () => {
    const quiet = await agentOf(RECONNECT_ONLY, (_p, reply) => {
      reply.tool('Waiting for a free slot (1 ahead)');
      setTimeout(() => quiet.drop(), 50);
    });
    const err = await sessionOn(quiet)
      .runTurn({ prompt: 'deploy it', sessionToken: 'tok', promptId: 'pid-5' }, recorder().handlers)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(quiet.connections).toBe(1);
    // An agent that did not declare promptId is not sent one.
    expect(quiet.prompts).toEqual([{ text: 'deploy it' }]);
    live?.dispose();

    const talking = await agentOf(RECONNECT_ONLY, (p, reply) => {
      if (p.reconnect) {
        reply.text('part two');
        reply.end();
        return;
      }
      reply.text('part one\n');
      setTimeout(() => talking.drop(), 50);
    });
    const out = recorder();
    await sessionOn(talking).runTurn({ prompt: 'deploy it', sessionToken: 'tok', promptId: 'pid-6' }, out.handlers);
    expect(out.text()).toBe('part one\npart two');
    expect(talking.prompts).toEqual([{ text: 'deploy it' }, { text: '', reconnect: true }]);
  });
});
