import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, ReclaimState } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * `/kill` — end the agent's process, keep the conversation.
 *
 * Two things are under test and they fail in different ways. The ACK has to say what happened,
 * for the reason `/stop`'s does. And the ORDER has to hold: a kill that let the merger run its
 * queued backlog would respawn the child it just ended, and a kill on a runtime that cannot resume
 * would quietly turn into `/new`. Both of those ack "ended" and look fine from the chat.
 */

/** Real timers with a 1 ms merge window, so a routed message actually reaches the agent stub. */
const realClock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** A DM inbound in the one conversation these tests use. */
function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** per_thread key: the trailing field is the empty lane. */
const KEY = 'discord#c1#';

function killRig(opts: { resumable?: boolean } = {}) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

  const sent: string[] = [];
  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `s${sent.length}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const log: string[] = [];
  const created: string[] = [];
  const factoryDisposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  let turns = 0;
  // What the stub's child is doing. 'no-child' until a turn spawns one, like both real runtimes.
  let child: ReclaimState = 'no-child';
  // A turn that settles only when something ends it — the wedged harness `/kill` is for. Both
  // exits resolve rather than reject, which is what the real runtimes' abort flag does.
  let endTurn: (() => void) | undefined;

  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      created.push(conversationId);
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: () => {
            turns++;
            child = opts.resumable === false ? 'unresumable' : 'resumable';
            return new Promise<void>((resolve) => (endTurn = resolve));
          },
          abort: () => {
            log.push('abort');
            endTurn?.();
          },
          dispose: () => {
            log.push('dispose');
            child = 'no-child';
            endTurn?.();
          },
          reclaimState: () => child,
        };
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => {
      factoryDisposed.push(id);
      sessions.delete(id);
    },
  };

  const calledOff: string[] = [];
  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, realClock, {
    cancelPendingAsks: (_id, reason) => {
      calledOff.push(reason);
      return 0;
    },
  });
  return { reg, sent, log, created, factoryDisposed, calledOff, turns: () => turns, peek: () => sessions.get(KEY) };
}

describe('ConversationRegistry /kill', () => {
  it('mid-turn: stops the turn, then ends the child — and says the conversation is kept', async () => {
    const r = killRig();
    r.reg.route(inbound('long task', 'm1'));
    await drain(); // running, and will never settle on its own

    const before = r.peek();
    r.reg.route(inbound('/kill', 'm2'));
    await drain();

    // Abort first (through the merger), THEN dispose — the order the kill depends on.
    expect(r.log).toEqual(['abort', 'dispose']);
    expect(r.sent.some((t) => t.startsWith('🔌 Stopped the turn and ended the agent process.'))).toBe(true);
    // The SESSION was disposed, not the factory's handle: the conversation keeps its runtime
    // choices, and the next message resumes rather than starting over.
    expect(r.factoryDisposed).toEqual([]);
    expect(r.peek()).toBe(before);
  });

  it('does not let the queued backlog respawn the child it just ended', async () => {
    const r = killRig();
    r.reg.route(inbound('long task', 'm1'));
    await drain();
    r.reg.route(inbound('and then this', 'm2')); // queued behind the running turn
    r.reg.route(inbound('/kill', 'm3'));
    await drain();

    // The regression this guards: disposing without interrupting the merger lets the turn "finish"
    // and the queue start a second one, which spawns a fresh child a moment after the ack.
    expect(r.turns()).toBe(1);
    // Kept rather than dropped, and the ack says so (InboundMerger.interrupt).
    expect(r.sent.at(-1)).toMatch(/^🔌 Stopped the turn and ended the agent process\..*\nKept this message for your next one .*\n> and then this$/s);

    r.reg.route(inbound('go on', 'm4'));
    await drain();
    expect(r.turns()).toBe(2);
  });

  it('idle with a resident child: ends it without an abort', async () => {
    const r = killRig();
    r.reg.route(inbound('hi', 'm1'));
    await drain();
    r.reg.route(inbound('/stop', 'm2')); // end the turn; the child stays resident
    await drain();
    r.log.length = 0;
    r.sent.length = 0;

    r.reg.route(inbound('/kill', 'm3'));
    await drain();

    expect(r.log).toEqual(['dispose']);
    expect(r.sent).toEqual([expect.stringMatching(/^🔌 Ended the agent process\./)]);
  });

  it('calls off questions still on screen — they belong to the process being ended', async () => {
    const r = killRig();
    r.reg.route(inbound('hi', 'm1'));
    await drain();
    r.reg.route(inbound('/kill', 'm2'));
    await drain();

    expect(r.calledOff).toContain('agent process ended');
  });

  it('an unresumable runtime: refuses, and touches nothing on the way to refusing', async () => {
    const r = killRig({ resumable: false });
    r.reg.route(inbound('long task', 'm1'));
    await drain();

    r.reg.route(inbound('/kill', 'm2'));
    await drain();

    // Not even the abort: stopping the turn and then declining the kill would do half of what was
    // asked while the ack said nothing happened.
    expect(r.log).toEqual([]);
    expect(r.calledOff).toEqual([]);
    expect(r.sent.some((t) => t.startsWith('Not ended: this agent cannot resume'))).toBe(true);
  });

  it('nothing ever ran: says so, and does not spawn an agent to find that out', async () => {
    const r = killRig();
    r.reg.route(inbound('/kill@bot', 'm1'));
    await drain();

    expect(r.sent).toEqual(['No agent process is running here — nothing to end.']);
    expect(r.created).toEqual([]);
  });

  it('is never forwarded to the agent as a prompt', async () => {
    const r = killRig();
    r.reg.route(inbound('/kill', 'm1'));
    await drain();

    expect(r.turns()).toBe(0);
  });
});
