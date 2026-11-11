import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, FollowUpSink } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * Out-of-turn output: what the gateway does when a harness keeps talking after its turn ended.
 *
 * The bug these pin: Claude Code puts long work in the background, ends its turn ("I've started
 * it, I'll report back"), and the Agent SDK re-invokes it on its own when the work finishes.
 * claude-agent-acp forwards that continuation as ordinary `session/update` notifications with no
 * prompt in flight — and the gateway used to have no reader and no address for them, so the
 * conversation went permanently silent at the exact moment the answer arrived.
 *
 * So the interesting assertions are about the two things that were missing: a message gets rendered
 * AT ALL once the turn is over, and it gets rendered only when there is something to show.
 */

const KEY: ConversationId = 'discord#c1#'; // per_thread (the default): empty trailing lane

function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** Let the 1 ms merge window elapse, the turn run, and the render chain drain. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/** What a scripted turn can reach: the sinks, and the log it shares with the platform. */
interface TurnControl {
  /** The sink installed for THIS turn — where output arriving as it ends would go. */
  current(): FollowUpSink;
  /**
   * The sink whose burst is still open, if any, taken so it is closed exactly once. The ACP
   * runtime keeps the same pairing (followUpState) because TurnRunner installs a fresh sink every
   * turn, and closing through the new one would leave the old burst open.
   */
  takeBurst(): FollowUpSink | undefined;
  events: string[];
}

function rig(
  opts: {
    footer?: boolean;
    runTurn?: (handlers: AgentStreamHandlers, ctl: TurnControl) => Promise<void>;
  } = {}
) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    // opencode rather than claude only so `/context` is answered locally by the gateway (on claude
    // it translates to the harness's own command and would be forwarded as a turn) — that is the
    // one observable place an out-of-turn usage snapshot shows up.
    agents: [{ id: 'oc', harness: 'opencode' }],
    routing: { default: 'oc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: opts.footer ?? false } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
  };

  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  /** Every message body the platform was asked to send, in order. */
  const sent: string[] = [];
  /** The latest text of every message, edits included — where a footer ends up. */
  const bodies = new Map<string, string>();
  /** Typing switched on and off, interleaved with whatever a scripted turn logs. */
  const events: string[] = [];
  let seq = 0;
  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      const messageId = `m${++seq}`;
      bodies.set(messageId, text);
      return { address, messageId };
    },
    editMessage: async (ref: { messageId: string }, text: string) => {
      bodies.set(ref.messageId, text);
    },
    addReaction: async () => {},
    startTyping: async () => void events.push('typing on'),
    stopTyping: async () => void events.push('typing off'),
  } as unknown as PlatformAdapter;

  /** The sink TurnRunner installed on the session — the seam the ACP pump feeds. */
  let sink: FollowUpSink | undefined;
  /** The sink a burst was opened through, until something closes it (see TurnControl.takeBurst). */
  let burst: FollowUpSink | undefined;
  const ctl: TurnControl = {
    current: () => {
      if (!sink) throw new Error('no follow-up sink was installed');
      return sink;
    },
    takeBurst: () => {
      const b = burst;
      burst = undefined;
      return b;
    },
    events,
  };
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, handlers: AgentStreamHandlers) => {
          if (opts.runTurn) return opts.runTurn(handlers, ctl);
          handlers.onText('starting it in the background');
        },
        abort: () => {},
        setFollowUpSink: (s) => {
          // Remembers which sink opened a burst, the way the runtime's followUpState does.
          sink = {
            handlers: () => {
              burst = s;
              return s.handlers();
            },
            close: () => s.close(),
          };
        },
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);

  return {
    reg,
    sent,
    bodies,
    events,
    /** The installed sink, once a turn has run. */
    sink: ctl.current,
  };
}

describe('follow-up rendering (background work reporting after the turn)', () => {
  it('renders output that arrives after the turn into a new message', async () => {
    const h = rig();
    h.reg.route(inbound('run the long script', 'm1'));
    await drain();
    expect(h.sent).toEqual(['starting it in the background']);

    // What the ACP pump does when the harness talks with no prompt in flight.
    const handlers = h.sink().handlers();
    handlers.onText('the script finished: 3 tests failed');
    h.sink().close();
    await drain();

    // The marker first, then the text — the two must not be able to arrive out of order, which is
    // why the marker is queued onto the render's own effects chain rather than sent directly.
    expect(h.sent).toHaveLength(3);
    expect(h.sent[1]).toContain('background update');
    expect(h.sent[2]).toBe('the script finished: 3 tests failed');
  });

  // The load-bearing negative. A harness reports a context snapshot after EVERY turn and again
  // whenever background work continues, so if metadata opened a message, every conversation would
  // collect an empty "background update" bubble on every exchange.
  it('sends nothing when the only out-of-turn event is metadata', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;

    const handlers = h.sink().handlers();
    handlers.onUsage?.({ used: 1000, size: 200_000 });
    handlers.onModel?.('opus-4-8');
    h.sink().close();
    await drain();

    expect(h.sent).toEqual([]);
  });

  // Usage recorded out of turn still has to reach `/context`: the numbers a background continuation
  // reports are the newest ones, and they arrive nowhere near a turn.
  it('records an out-of-turn context snapshot even with nothing rendered', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.sink().handlers().onUsage?.({ used: 12_345, size: 200_000 });
    h.sink().close();

    h.reg.route(inbound('/context', 'm2'));
    await drain();
    expect(h.sent.join('\n')).toContain('12k / 200k');
  });

  // A background cycle that fails (or retries) has nothing to render, and its notice must still
  // reach the chat: with typed failure records, the adapter no longer puts the error text into the
  // agent's own message stream (see session-failure.ts).
  it('posts a notice on its own, without opening a background-update message', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;
    h.events.length = 0;

    h.sink().handlers().onNotice?.('❌ oc: API Error: 500 Database error');
    await drain();

    expect(h.sent).toEqual(['❌ oc: API Error: 500 Database error']);
    expect(h.events).not.toContain('typing on');
  });

  // close() is called by every path that can end a burst (result, new turn, quiet timer, a child
  // going away), so it has to be safe to call twice and safe to call having rendered nothing.
  it('is idempotent and safe with nothing open', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;

    h.sink().close();
    h.sink().close();
    await drain();
    expect(h.sent).toEqual([]);
  });

  // A second burst is a second message, not a continuation of the first: handlers() resets the
  // render, so text after a close cannot land in the message that was already sealed.
  it('opens a fresh message for each burst', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;

    const first = h.sink().handlers();
    first.onText('job one done');
    h.sink().close();
    await drain();

    const second = h.sink().handlers();
    second.onText('job two done');
    h.sink().close();
    await drain();

    expect(h.sent.filter((t) => t.includes('background update'))).toHaveLength(2);
    expect(h.sent).toContain('job one done');
    expect(h.sent).toContain('job two done');
  });
});

/**
 * A background report is the agent working, and has to read as such. Every surface that says
 * "running" reads the typing indicator — on the web UI the topic's pulsing dot, the "running"
 * label and the Stop button — and a burst used to hold none of it: reported 2026-09-24, a
 * conversation ran minutes of deploy commands under a topic marked idle, with no way to stop it.
 */
describe('a conversation reads as running while background output renders', () => {
  it('holds typing from the first output until the burst is sealed', async () => {
    const h = rig();
    h.reg.route(inbound('run the long script', 'm1'));
    await drain();
    h.events.length = 0;

    const handlers = h.sink().handlers();
    handlers.onUsage?.({ used: 1000, size: 200_000 });
    // Metadata is not work: the post-turn reports every conversation receives must not light it.
    expect(h.events).toEqual([]);

    handlers.onText('the script finished');
    expect(h.events).toEqual(['typing on']);

    await h.sink().close();
    await drain();
    expect(h.events).toEqual(['typing on', 'typing off']);
  });

  // The handover the counting exists for. The runtime seals the previous burst from INSIDE the next
  // turn, after that turn has already switched typing on — so a burst that simply switched it off
  // on close would do it to a turn that had just begun.
  it('does not switch typing off under a turn that takes over from an open burst', async () => {
    const h = rig({
      runTurn: async (handlers, ctl) => {
        await ctl.takeBurst()?.close(); // what runTurn in the ACP runtime does first, awaited
        ctl.events.push('turn working');
        handlers.onText('answer');
      },
    });
    h.reg.route(inbound('start the job', 'm1'));
    await drain();

    h.sink().handlers().onText('the job reported in');
    h.events.length = 0;
    h.reg.route(inbound('and now this', 'm2'));
    await drain();

    expect(h.events).toEqual(['typing on', 'turn working', 'typing off']);
  });

  // The reverse gap: a turn's cleanup runs after the runtime stopped routing to it, so background
  // output can open a burst in between — and the turn's cleanup must not switch that one off.
  it('does not let a finishing turn switch typing off under a burst that just opened', async () => {
    const h = rig({
      runTurn: async (handlers, ctl) => {
        handlers.onText('started it');
        ctl.current().handlers().onText('and it already reported back');
      },
    });
    h.reg.route(inbound('start the job', 'm1'));
    await drain();
    expect(h.events).toEqual(['typing on', 'typing on']);

    await h.sink().close();
    await drain();
    expect(h.events).toEqual(['typing on', 'typing on', 'typing off']);
  });

  it('names the model and effort it was told before its first text', async () => {
    const h = rig({ footer: true });
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    // The runtime reports both the moment a burst begins; the message opens on the first text.
    const handlers = h.sink().handlers();
    handlers.onModel?.('opus-5-5');
    handlers.onEffort?.('high');
    handlers.onText('deployed');
    await h.sink().close();
    await drain();

    const report = [...h.bodies.values()].find((b) => b.includes('deployed'));
    expect(report).toContain('opus-5-5');
    expect(report).toContain('high');
  });
});

describe('the lane survives the turn that established it', () => {
  // The reverse CLI's own version of the same bug: a background job calling
  // `fleetherd send-message` between turns used to be refused outright with "this conversation
  // has no active turn right now", so its whole report went nowhere.
  it('resolves a reverse-command address after the turn has ended', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    // The token the agent child was given; it is stable for the life of the conversation.
    const token = (h.reg as unknown as { tokens: { tokenFor(id: string): string } }).tokens.tokenFor(KEY);
    expect(h.reg.resolveAddress(token)).toMatchObject({ channel: 'c1' });
  });

  it('still refuses when the conversation has never run a turn', () => {
    const h = rig();
    // Route a daemon command: it creates no state and runs no turn, so there is no lane yet.
    h.reg.route(inbound('/help', 'm1'));
    expect(() => h.reg.resolveAddress('not-a-token')).toThrow(/invalid session token/);
  });
});
