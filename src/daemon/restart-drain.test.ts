import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { DRAIN_LIMIT_MS, describeInProgress, whenIdle, type InProgress } from './restart-drain.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage, SteerOutcome } from '../types.js';

/**
 * A SIGTERM with work in progress (an update recreating the container): the gateway waits for the
 * turns already running, and starts nothing new meanwhile. The daemon's signal handler is wiring
 * around these two halves — the bounded wait, and what the registry does with messages while it
 * lasts — so these are what is pinned.
 */

function manualClock(start = 0) {
  let t = start;
  let timers: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: t + ms };
      timers.push(entry);
      return () => {
        timers = timers.filter((e) => e !== entry);
      };
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        timers = timers.filter((e) => e !== due);
        due.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

describe('whenIdle', () => {
  it('waits for the work in progress, then is done once', () => {
    const clock = manualClock();
    let now: InProgress = { turns: 2, runs: 1 };
    const done: InProgress[] = [];
    whenIdle(() => now, clock, (left) => done.push(left));
    clock.advance(5_000);
    expect(done).toEqual([]);
    now = { turns: 0, runs: 0 };
    clock.advance(1_000);
    expect(done).toEqual([{ turns: 0, runs: 0 }]);
    clock.advance(10_000);
    expect(done).toHaveLength(1);
  });

  it('gives up at the limit, with what was still in progress', () => {
    const clock = manualClock();
    const done: InProgress[] = [];
    whenIdle(() => ({ turns: 1, runs: 0 }), clock, (left) => done.push(left));
    clock.advance(DRAIN_LIMIT_MS - 1_000);
    expect(done).toEqual([]);
    clock.advance(1_000);
    expect(done).toEqual([{ turns: 1, runs: 0 }]);
  });

  it('can be cancelled — by the stop a second signal starts', () => {
    const clock = manualClock();
    const done: InProgress[] = [];
    const cancel = whenIdle(() => ({ turns: 1, runs: 0 }), clock, (left) => done.push(left));
    cancel();
    clock.advance(DRAIN_LIMIT_MS);
    expect(done).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('says what it is waiting for', () => {
    expect(describeInProgress({ turns: 2, runs: 1 })).toBe('2 turns and 1 scheduled run');
    expect(describeInProgress({ turns: 1, runs: 0 })).toBe('1 turn');
  });
});

function config(): Config {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
  });
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Turns run until released; `steer` undefined = an agent that cannot take input mid-turn. */
function rig(steer?: SteerOutcome) {
  const prompts: string[] = [];
  const steered: string[] = [];
  const sent: Array<{ channel: string; text: string }> = [];
  const release = new Map<string, () => void>();
  /** Conversations whose agent is reporting in on background work, with no turn running. */
  const background = new Set<string>();
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => {
            prompts.push(input.prompt);
            await new Promise<void>((r) => release.set(conversationId, r));
          },
          ...(steer
            ? {
                steer: async (input: { prompt: string }) => {
                  steered.push(input.prompt);
                  return steer;
                },
              }
            : {}),
          abort: () => release.get(conversationId)?.(),
          backgroundActive: () => [...background].some((c) => conversationId.includes(c)),
          dispose: () => {},
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };
  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push({ channel: address.channel, text });
      return { address, messageId: 'out' };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const reg = new ConversationRegistry(config(), new Map([['discord', platform]]), factory, clock);

  let n = 0;
  const send = async (channel: string, content: string): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel, kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await settle();
  };
  const finish = async (channel: string): Promise<void> => {
    for (const [id, r] of release) if (id.includes(channel)) r();
    await settle();
  };
  const said = (channel: string): string[] => sent.filter((s) => s.channel === channel).map((s) => s.text);
  return { reg, send, finish, prompts, steered, said, background };
}

describe('while the gateway waits to restart', () => {
  it('tells a conversation at work, refuses to start a turn in an idle one, and counts down to idle', async () => {
    const r = rig();
    await r.send('busy', 'run the suite');
    await r.send('quiet', 'hello');
    await r.finish('quiet');
    expect(r.reg.turnsInProgress()).toBe(1);

    r.reg.beginDrain();
    await settle();
    expect(r.said('busy').at(-1)).toMatch(/restarts when this turn is done/);
    expect(r.said('quiet').join('\n')).not.toMatch(/restart/);

    await r.send('quiet', 'one more thing');
    await r.send('new', 'a conversation never seen before');
    expect(r.prompts).toEqual(['run the suite', 'hello']);
    expect(r.said('quiet').at(-1)).toMatch(/Not sent to the agent/);
    expect(r.said('new').at(-1)).toMatch(/Not sent to the agent/);
    expect(r.reg.turnsInProgress()).toBe(1);

    await r.finish('busy');
    expect(r.reg.turnsInProgress()).toBe(0);
  });

  it('waits for an agent working on its own after its turn ended', async () => {
    // The harness re-invoked itself when a background task finished: the merger is idle, and a
    // restart that counted only turns stopped at once, cutting the agent off mid-command.
    const r = rig();
    await r.send('bg', 'release, then report');
    await r.finish('bg');
    expect(r.reg.turnsInProgress()).toBe(0);

    r.background.add('bg');
    expect(r.reg.turnsInProgress()).toBe(1);
    r.reg.beginDrain();
    await settle();
    expect(r.said('bg').at(-1)).toMatch(/restarts when this turn is done/);

    r.background.delete('bg');
    expect(r.reg.turnsInProgress()).toBe(0);
  });

  it('still hands a message to the turn it is waiting for', async () => {
    const r = rig('joined');
    await r.send('busy', 'run the suite');
    r.reg.beginDrain();
    await r.send('busy', 'also check the docs');
    expect(r.steered).toEqual(['also check the docs']);
    expect(r.said('busy').join('\n')).not.toMatch(/Not sent/);
  });

  it('still stops a turn on /stop, which is how the wait is cut short from the chat', async () => {
    const r = rig();
    await r.send('busy', 'run the suite');
    r.reg.beginDrain();
    await r.send('busy', '/stop');
    expect(r.reg.turnsInProgress()).toBe(0);
  });
});
