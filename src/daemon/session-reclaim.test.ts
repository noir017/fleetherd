import { describe, expect, it, vi } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, ReclaimState } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * Idle reclaim: stopping a conversation's resident agent child without stopping the conversation.
 *
 * What these pin is not the timer — it is the four gates. Reclaim is the daemon-restart path
 * applied to one conversation, so it is safe exactly when the next message could pick the
 * conversation back up, and the tests that matter most are the ones asserting it does NOT fire:
 * mid-turn, with a pending `ask`, on a session that cannot resume, or on one that a background job
 * is still talking to over the reverse CLI. Each of those, if it fired, would look to the user like
 * the agent silently forgetting a task it was in the middle of.
 */

const KEY: ConversationId = 'discord#c1#'; // per_thread (the default): empty trailing lane
const IDLE_MS = 30 * 60_000;

function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** Let the 1 ms merge window elapse so a routed message becomes a completed turn. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

interface RigOptions {
  /** What the stub session reports when the sweeper asks. */
  reclaimState?: ReclaimState;
  /** Turns that never settle, so the conversation is observably mid-turn. */
  hang?: boolean;
  /** The daemon's answer to "are you holding out-of-turn work for this conversation?" */
  pendingWork?: boolean;
  /** 0 disables reclaim entirely. */
  idleTimeoutMs?: number;
}

function rig(opts: RigOptions = {}) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    session: { idleTimeoutMs: opts.idleTimeoutMs ?? IDLE_MS },
    display: { header: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

  // Manual `now` over real timers: the merge window still elapses (so turns actually run), while
  // the test moves the idle clock by hours without waiting for any of them.
  let t = 0;
  const clock = {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }) => ({ address, messageId: 'm' }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  // Whether each stub currently has a "child", the way both real runtimes track theirs: a turn
  // spawns one and dispose tears it down, and reclaimState answers from that rather than from the
  // handle's existence. Without it the stub would report a reclaimed session as still running,
  // which is precisely the confusion liveForRef exists to clear up.
  const down = new Set<string>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          // A turn spawns the child before it does anything else, hang or no hang — otherwise the
          // mid-turn test would be passing on "there is nothing to reclaim" instead of on the gate
          // it is named for.
          runTurn: () => {
            down.delete(conversationId);
            return opts.hang ? new Promise<void>(() => {}) : Promise.resolve();
          },
          abort: () => {},
          reclaimState: () => (down.has(conversationId) ? 'no-child' : (opts.reclaimState ?? 'resumable')),
          // Note what dispose does NOT do here, mirroring both real runtimes: the handle stays in
          // the map and rebuilds its child on the next turn.
          dispose: () => {
            disposed.push(conversationId);
            down.add(conversationId);
          },
        };
        // A handle built for a conversation that has not run a turn yet has no child either.
        down.add(conversationId);
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock, {
    hasPendingWork: () => opts.pendingWork ?? false,
  });

  return {
    reg,
    disposed,
    factory,
    /** Stand in for the spawn a real turn does, when a test replaces runTurn with its own. */
    spawn: (id: ConversationId) => void down.delete(id),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('idle reclaim', () => {
  it('stops the child of a conversation that has been quiet past the deadline', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain(); // turn ran and ended: the idle clock starts here

    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([KEY]);
  });

  it('leaves the conversation itself intact: the next message resumes the same one', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();

    // The whole promise of reclaim: the session handle (and with it the binding and the model
    // choice) survives, so the follow-up is the same conversation rather than a new one.
    const session = h.factory.peek(KEY);
    expect(session).toBeDefined();
    h.reg.route(inbound('still here?', 'm2'));
    await drain();
    expect(h.factory.peek(KEY)).toBe(session);
  });

  it('does not fire before the deadline', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.advance(IDLE_MS - 60_000);
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([]);
  });

  it('never fires mid-turn, however long the turn has been running', async () => {
    const h = rig({ hang: true });
    h.reg.route(inbound('a task that takes hours', 'm1'));
    await drain(); // the turn is running and will not settle

    h.advance(IDLE_MS * 10);
    h.reg.reclaimIdleSessions();

    // The clock only starts when the turn ENDS, so a long task (subagents included) is never a
    // candidate. This is the gate that would otherwise kill work in flight.
    expect(h.disposed).toEqual([]);
  });

  it('never fires while the daemon holds out-of-turn work (a pending ask)', async () => {
    const h = rig({ pendingWork: true });
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.advance(IDLE_MS * 2);
    h.reg.reclaimIdleSessions();

    // From the registry's side this conversation looks idle; a CLI process is blocked on a button.
    expect(h.disposed).toEqual([]);
  });

  it('never fires on a session that cannot resume, and says so exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = rig({ reclaimState: 'unresumable' });
      h.reg.route(inbound('hello', 'm1'));
      await drain();

      h.advance(IDLE_MS * 2);
      h.reg.reclaimIdleSessions();
      h.reg.reclaimIdleSessions();
      h.reg.reclaimIdleSessions();

      expect(h.disposed).toEqual([]);
      // Explicit degradation, but once — not a warning per minute for the life of the daemon.
      const mine = warn.mock.calls.filter((c) => String(c[0]).includes('cannot resume'));
      expect(mine).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a reverse command keeps a conversation warm between turns', async () => {
    const h = rig();
    h.reg.route(inbound('start a background job', 'm1'));
    await drain();

    // Half the window passes, then the agent's background job reports in over the reverse CLI.
    h.advance(IDLE_MS - 60_000);
    h.reg.touch(KEY);
    h.advance(IDLE_MS - 60_000);
    h.reg.reclaimIdleSessions();

    // Without the touch this conversation would be well past the deadline by now.
    expect(h.disposed).toEqual([]);
  });

  it('idleTimeoutMs=0 disables reclaim entirely', async () => {
    const h = rig({ idleTimeoutMs: 0 });
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.advance(IDLE_MS * 100);
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([]);
  });

  it('a reclaimed conversation is not reclaimed again on the next sweep', async () => {
    // After the child is gone the session reports no-child; the sweeper must read that as "nothing
    // to do" rather than logging a reclaim every minute forever.
    let state: ReclaimState = 'resumable';
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    const session = h.factory.peek(KEY)!;
    (session as { reclaimState: () => ReclaimState }).reclaimState = () => state;

    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();
    state = 'no-child'; // what a real runtime reports once its child is down
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([KEY]);
  });

  it('reclaimAfterAskTimeout stops the child immediately when conversation is idle', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    expect(h.disposed).toEqual([]);
    h.reg.reclaimAfterAskTimeout(KEY);
    expect(h.disposed).toEqual([KEY]);
  });

  it('reclaimAfterAskTimeout defers reclaim if a turn is running, and stops child when turn ends', async () => {
    let finishTurn: () => void = () => {};
    const turnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const h = rig();
    const session = h.factory.getOrCreate(KEY, 'cc');
    (session as unknown as { runTurn: () => Promise<void> }).runTurn = () => turnPromise;
    h.spawn(KEY);

    h.reg.route(inbound('hello', 'm1'));
    await new Promise((r) => setTimeout(r, 10));

    h.reg.reclaimAfterAskTimeout(KEY);
    expect(h.disposed).toEqual([]);

    finishTurn();
    await drain();

    expect(h.disposed).toEqual([KEY]);
  });
});

/**
 * The same fact reclaim is built on, asked from the other side: a platform that draws its own
 * conversation list (the web UI's topic switcher) wants to know whether an agent is still up.
 */
describe('liveForRef', () => {
  const ref = { platform: 'discord', channel: 'c1', kind: 'direct' as const, user: 'u1' };

  it('separates a quiet conversation from one with nothing left running', async () => {
    const h = rig();
    // Never run here: there is a row for it in the list, and nothing behind it.
    expect(h.reg.liveForRef(ref)).toBe(false);

    h.reg.route(inbound('hello', 'm1'));
    await drain();
    // The turn is over and the child is not. This is the state that used to be indistinguishable
    // from the line above, and it is the one where the next message is answered straight away.
    expect(h.reg.liveForRef(ref)).toBe(true);

    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();
    expect(h.reg.liveForRef(ref)).toBe(false);
  });

  it('reports a session that cannot state its own liveness as not running', async () => {
    // Read the way the sweeper reads it: of the two possible lies, "the agent is already up" is
    // the one that would be believed.
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    const session = h.factory.peek(KEY)!;
    delete (session as { reclaimState?: unknown }).reclaimState;

    expect(h.reg.liveForRef(ref)).toBe(false);
  });
});

/**
 * The web UI's "Close idle agents": reclaim asked for now, by address, instead of on the timer.
 * What has to hold is that being asked replaces the deadline and nothing else — every other gate
 * still says no, because the page's idea of idle can be seconds old.
 */
describe('reclaimIdleForRef', () => {
  const ref = { platform: 'discord', channel: 'c1', kind: 'direct' as const, user: 'u1' };

  it('ends an idle child without waiting for the deadline, and keeps the conversation', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    expect(h.reg.reclaimIdleForRef(ref)).toBe(true);
    expect(h.disposed).toEqual([KEY]);
    expect(h.reg.liveForRef(ref)).toBe(false);
    expect(h.factory.peek(KEY)).toBeDefined();
    // Nothing left to end the second time.
    expect(h.reg.reclaimIdleForRef(ref)).toBe(false);
  });

  it.each([
    ['mid-turn', { hang: true }],
    ['with a question pending', { pendingWork: true }],
    ['on a runtime that cannot resume', { reclaimState: 'unresumable' as const }],
  ])('leaves the child alone %s', async (_label, opts: RigOptions) => {
    const h = rig(opts);
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    expect(h.reg.reclaimIdleForRef(ref)).toBe(false);
    expect(h.disposed).toEqual([]);
  });

  it('answers false for a conversation that never ran here', () => {
    expect(rig().reg.reclaimIdleForRef(ref)).toBe(false);
  });
});

/**
 * What the review sweep asks the registry: the same facts the idle sweeper decides on, exposed as
 * data. The point of pinning them here is that "quiet enough to review" must never be answered by
 * a conversation that is mid-turn, waiting on a person, or still holding a child it can resume.
 */
describe('reviewFacts', () => {
  it('reports the conversation as live until reclaim stops the child', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    const before = h.reg.reviewFacts();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      key: KEY,
      busyTurn: false,
      stopped: false,
      unresumable: false,
      pendingWork: false,
      lane: { platform: 'discord', channel: 'c1' },
    });

    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();
    expect(h.reg.reviewFacts()[0]).toMatchObject({ stopped: true, busyTurn: false });
    expect(h.reg.reviewFacts()[0]!.idleMs).toBeGreaterThanOrEqual(IDLE_MS);
  });

  it('reports a turn in flight as busy', async () => {
    const h = rig({ hang: true });
    h.reg.route(inbound('a long task', 'm1'));
    await drain();
    expect(h.reg.reviewFacts()[0]!.busyTurn).toBe(true);
  });

  it('reports a pending question, and a child that cannot resume', async () => {
    const pending = rig({ pendingWork: true });
    pending.reg.route(inbound('hello', 'm1'));
    await drain();
    expect(pending.reg.reviewFacts()[0]!.pendingWork).toBe(true);

    const stuck = rig({ reclaimState: 'unresumable' });
    stuck.reg.route(inbound('hello', 'm1'));
    await drain();
    expect(stuck.reg.reviewFacts()[0]).toMatchObject({ unresumable: true, stopped: false });
  });

  it('has nothing to say about a conversation that never ran here', () => {
    expect(rig().reg.reviewFacts()).toEqual([]);
  });
});
