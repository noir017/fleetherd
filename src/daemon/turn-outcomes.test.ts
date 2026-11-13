import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../config/schema.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { TopicActivity } from '../types.js';
import { TurnFailure } from './agent.js';
import { ConversationStore } from './conversation-store.js';
import { CARD_ITEM_CHARS } from './delegation.js';
import { TurnOutcomes } from './turn-outcomes.js';

/**
 * What a turn leaves for the person, and hooks.turnFailed's automatic continue (turn-outcomes.ts).
 * Driven with a hand-cranked clock, so "the person wrote before the continue was due" is a step in
 * the test rather than a race.
 */

const ID = 'web#main#aa';
const LANE = { address: { channel: 'main', thread: 'aa' } as ConversationAddress, platformId: 'web' };

function config(continueBlock?: Record<string, unknown>): Config {
  return parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude', ...(continueBlock ? { hooks: { turnFailed: { continue: continueBlock } } } : {}) }],
    routing: { default: 'cc', pipeline: [] },
  });
}

/** A clock whose timers fire only when the test says so. */
function manualClock() {
  let now = 1_000;
  let timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    /** Advance and run whatever came due, in order. */
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.live && t.at <= now).sort((a, b) => a.at - b.at);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) t.fn();
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

function rig(cfg: Config, store?: ConversationStore) {
  const clock = manualClock();
  const said: string[] = [];
  const pushed: Array<TopicActivity | undefined> = [];
  const continued: string[] = [];
  const needs: string[] = [];
  const platform = {
    sendMessage: async (_a: ConversationAddress, text: string) => {
      said.push(text);
      return { address: LANE.address, messageId: 'x' };
    },
    setActivity: (_a: ConversationAddress, activity: TopicActivity | undefined) => {
      pushed.push(activity);
    },
  } as unknown as PlatformAdapter;
  const outcomes = new TurnOutcomes({
    config: cfg,
    clock,
    platforms: new Map([['web', platform]]),
    store,
    laneOf: () => LANE,
    agentIdOf: () => 'cc',
    runContinue: (_id, text) => {
      continued.push(text);
      return true;
    },
    onNeedsPerson: (id) => needs.push(id),
  });
  return { clock, said, pushed, continued, needs, outcomes, last: () => pushed[pushed.length - 1] };
}

const fail = (reason: ConstructorParameters<typeof TurnFailure>[1], message = 'upstream 503') => ({
  kind: 'failed' as const,
  error: new TurnFailure(message, reason),
});

describe('TurnOutcomes — what a turn leaves for the person', () => {
  it('a finished turn leaves its first line to read, and tells whoever listens', () => {
    const r = rig(config());
    r.outcomes.turnStarted(ID);
    expect(r.last()).toEqual({});
    r.outcomes.turnEnded(ID, { kind: 'done', text: '**Done:** the bump is green.\n\nmore' });
    expect(r.last()).toEqual({ outcome: { kind: 'done', at: 1_000, line: 'Done: the bump is green.' } });
    expect(r.needs).toEqual([ID]);
  });

  it('keeps a finished reply for the update card, bounded and with its whole length', () => {
    const r = rig(config());
    const text = `## Review\n\n${'x'.repeat(5_000)}`;
    r.outcomes.turnEnded(ID, { kind: 'done', text });
    expect(r.outcomes.replyOf(ID)).toEqual({ text: text.slice(0, CARD_ITEM_CHARS), total: text.length });
    // The next turn supersedes it, as the activity does.
    r.outcomes.turnStarted(ID);
    expect(r.outcomes.replyOf(ID)).toBeUndefined();
  });

  it('keeps a failed turn’s error bounded too, while the list still gets one line', () => {
    const r = rig(config());
    const message = `failed: ${'y'.repeat(5_000)}`;
    r.outcomes.turnEnded(ID, fail('service', message));
    expect(r.outcomes.failureOf(ID)).toEqual({ text: message.slice(0, CARD_ITEM_CHARS), total: message.length });
    expect(r.last()?.outcome?.line).toHaveLength(120);
    r.outcomes.forget(ID);
    expect(r.outcomes.failureOf(ID)).toBeUndefined();
  });

  it('lets a released conversation go whole: its texts and its outcome, pushing nothing', () => {
    const r = rig(config());
    r.outcomes.turnEnded(ID, { kind: 'done', text: 'a long enough reply' });
    const pushes = r.pushed.length;
    r.outcomes.release(ID);
    expect(r.outcomes.replyOf(ID)).toBeUndefined();
    // The outcome used to stay: one entry per run of a scheduled task with no topic of its own.
    expect(r.outcomes.activityOf(ID)).toBeUndefined();
    // Its lane is the person's own conversation; that list entry is not the run's to clear.
    expect(r.pushed).toHaveLength(pushes);
  });

  it('a released conversation’s pending continue is called off rather than fired at nothing', () => {
    const r = rig(config({ on: ['service'], max: 2 }));
    r.outcomes.turnEnded(ID, fail('service'));
    expect(r.clock.pending()).toBe(1);
    r.outcomes.release(ID);
    expect(r.clock.pending()).toBe(0);
    r.clock.advance(10 * 60_000);
    expect(r.continued).toEqual([]);
    expect(r.outcomes.activityOf(ID)).toBeUndefined();
  });

  it('a stopped turn leaves nothing', () => {
    const r = rig(config());
    r.outcomes.turnEnded(ID, { kind: 'stopped' });
    expect(r.last()).toEqual({});
    expect(r.needs).toEqual([]);
  });

  it('a failure without a policy is left for the person, with its reason', () => {
    const r = rig(config());
    r.outcomes.turnEnded(ID, fail('service'));
    expect(r.last()).toEqual({ outcome: { kind: 'failed', at: 1_000, line: 'upstream 503', reason: 'service' } });
    expect(r.needs).toEqual([ID]);
    expect(r.said).toEqual([]);
    expect(r.clock.pending()).toBe(0);
  });

  it('an unclassified error reads as `other`', () => {
    const r = rig(config({ on: ['other'], max: 1 }));
    r.outcomes.turnEnded(ID, { kind: 'failed', error: new Error('boom') });
    expect(r.last()?.outcome?.reason).toBe('other');
    expect(r.last()?.retry).toBeDefined();
  });

  it('/new forgets the outcome and tells the platform', () => {
    const r = rig(config());
    r.outcomes.turnEnded(ID, fail('service'));
    r.outcomes.forget(ID);
    expect(r.last()).toBeUndefined();
    expect(r.outcomes.activityOf(ID)).toBeUndefined();
  });
});

describe('TurnOutcomes — hooks.turnFailed.continue', () => {
  it('continues after a reason it names, saying so first, with a doubling wait', () => {
    const r = rig(config({ on: ['service'], message: '继续', max: 3, backoffMs: 30_000 }));
    r.outcomes.turnStarted(ID);
    r.outcomes.turnEnded(ID, fail('service'));
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toContain('“继续” in 30s (1/3)');
    expect(r.last()?.retry).toEqual({ attempt: 1, max: 3, at: 31_000 });
    expect(r.needs).toEqual([]); // not yet: the gateway is still handling it

    r.clock.advance(29_999);
    expect(r.continued).toEqual([]);
    r.clock.advance(1);
    expect(r.continued).toEqual(['继续']);

    // The continue runs and fails again: the next wait is twice as long.
    r.outcomes.turnStarted(ID);
    expect(r.last()).toEqual({});
    r.outcomes.turnEnded(ID, fail('service'));
    expect(r.said[1]).toContain('in 1 min (2/3)');
    r.clock.advance(60_000);
    expect(r.continued).toEqual(['继续', '继续']);

    // …and this one works: the count is reset, and the reply is the person's to read.
    r.outcomes.turnStarted(ID);
    r.outcomes.turnEnded(ID, { kind: 'done', text: 'ok' });
    expect(r.needs).toEqual([ID]);
    r.outcomes.turnEnded(ID, fail('service'));
    expect(r.said[2]).toContain('(1/3)');
  });

  it('gives up after `max` in a row, says so, and leaves the failure for the person', () => {
    const r = rig(config({ on: ['hung'], max: 2, backoffMs: 1_000 }));
    for (let i = 0; i < 2; i++) {
      r.outcomes.turnEnded(ID, fail('hung'));
      r.clock.advance(10_000);
      r.outcomes.turnStarted(ID);
    }
    expect(r.continued).toEqual(['continue', 'continue']);
    r.outcomes.turnEnded(ID, fail('hung'));
    expect(r.said[r.said.length - 1]).toContain('Not continuing again: 2 automatic continues');
    expect(r.last()?.retry).toBeUndefined();
    expect(r.last()?.outcome?.kind).toBe('failed');
    expect(r.needs).toEqual([ID]);
    expect(r.clock.pending()).toBe(0);
  });

  it('does not continue after a reason it does not name', () => {
    const r = rig(config({ on: ['service'] }));
    r.outcomes.turnEnded(ID, fail('access', 'agent "cc" must be logged in'));
    expect(r.clock.pending()).toBe(0);
    expect(r.said).toEqual([]);
    expect(r.needs).toEqual([ID]);
  });

  it('defaults to service, connection, limit, hung and restart', () => {
    const r = rig(config({}));
    for (const reason of ['service', 'connection', 'limit', 'hung', 'restart'] as const) {
      r.outcomes.personActed(ID);
      r.outcomes.turnEnded(ID, fail(reason));
      expect(r.last()?.retry, reason).toBeDefined();
    }
    r.outcomes.personActed(ID);
    r.outcomes.turnEnded(ID, fail('request'));
    expect(r.last()?.retry).toBeUndefined();
  });

  it('anything the person does calls a waiting continue off', () => {
    const r = rig(config({ on: ['service'], backoffMs: 5_000 }));
    r.outcomes.turnEnded(ID, fail('service'));
    expect(r.last()?.retry).toBeDefined();
    r.outcomes.personActed(ID);
    expect(r.last()).toEqual({ outcome: { kind: 'failed', at: 1_000, line: 'upstream 503', reason: 'service' } });
    r.clock.advance(60_000);
    expect(r.continued).toEqual([]);
  });

  it('a turn that starts for any other reason supersedes the waiting continue', () => {
    const r = rig(config({ on: ['service'], backoffMs: 5_000 }));
    r.outcomes.turnEnded(ID, fail('service'));
    r.outcomes.turnStarted(ID); // e.g. a scheduled task's turn
    r.clock.advance(60_000);
    expect(r.continued).toEqual([]);
  });

  it('a continue that cannot be sent leaves the failure for the person', () => {
    const r = rig(config({ on: ['service'], backoffMs: 1_000 }));
    const outcomes = new TurnOutcomes({
      config: config({ on: ['service'], backoffMs: 1_000 }),
      clock: r.clock,
      platforms: new Map(),
      laneOf: () => LANE,
      agentIdOf: () => 'cc',
      runContinue: () => false,
      onNeedsPerson: (id) => r.needs.push(id),
    });
    outcomes.turnEnded(ID, fail('service'));
    r.clock.advance(1_000);
    expect(outcomes.activityOf(ID)?.retry).toBeUndefined();
    expect(r.needs).toEqual([ID]);
  });
});

describe('TurnOutcomes — a usage limit cools the whole agent down', () => {
  /** Conversations A…H on one agent, continues recorded by conversation. */
  function many(cfg: Config, opts: { cardsHeld?: string[] } = {}) {
    const clock = manualClock();
    const said: Array<[string, string]> = [];
    const continued: string[] = [];
    const needs: string[] = [];
    const over: string[] = [];
    const platform = {
      sendMessage: async (a: ConversationAddress, text: string) => {
        said.push([a.thread ?? '', text]);
        return { address: a, messageId: 'x' };
      },
      setActivity: () => {},
    } as unknown as PlatformAdapter;
    const outcomes = new TurnOutcomes({
      config: cfg,
      clock,
      platforms: new Map([['web', platform]]),
      laneOf: (id) => ({ address: { channel: 'main', thread: id }, platformId: 'web' }),
      agentIdOf: () => 'cc',
      runContinue: (id) => {
        continued.push(id);
        return true;
      },
      onNeedsPerson: (id) => needs.push(id),
      onCooldownOver: (agent) => {
        over.push(agent);
        opts.cardsHeld?.push(agent);
      },
    });
    return { clock, said, continued, needs, over, outcomes };
  }
  const limit = () => fail('limit', 'All credentials for model opus are cooling down');

  it('sends one continue to find out, not one per conversation, and lets the rest go once it gets through', () => {
    // 2026-11-07: eight sub-agents hit the limit together and each continued three times on its own.
    const r = many(config({ on: ['limit'], max: 3, backoffMs: 30_000 }));
    const ids = ['A', 'B', 'C', 'D'];
    for (const id of ids) r.outcomes.turnEnded(id, limit());
    expect(r.outcomes.coolingDown('cc')).toBe(true);
    // A burst is one piece of news: the wait is the first one, not four times doubled.
    expect(r.outcomes.activityOf('A')?.retry).toEqual({ attempt: 1, max: 3, at: 31_000 });
    expect(r.outcomes.activityOf('D')?.retry).toEqual({ attempt: 1, max: 3, at: 31_000 });
    expect(r.said.find(([t]) => t === 'A')?.[1]).toBe(
      '↻ A usage limit was hit on cc — sending “continue” in 30s (1/3). Send anything, or /stop, to call it off.'
    );
    expect(r.said.find(([t]) => t === 'B')?.[1]).toContain('once another conversation on it gets through (1/3)');

    r.clock.advance(30_000);
    expect(r.continued).toEqual(['A']);
    // The probe hits the limit again: only it tries again, after twice the wait.
    r.outcomes.turnStarted('A');
    r.outcomes.turnEnded('A', limit());
    expect(r.outcomes.activityOf('A')?.retry).toEqual({ attempt: 2, max: 3, at: 91_000 });
    r.clock.advance(59_999);
    expect(r.continued).toEqual(['A']);
    r.clock.advance(1);
    expect(r.continued).toEqual(['A', 'A']);
    // Back at the front of the line, it says who waits behind it.
    expect(r.said.filter(([t]) => t === 'A').at(-1)?.[1]).toContain('in 1 min (2/3); 3 more conversations wait for this one to get through');
    // …and gets through: everyone waiting goes now, and the cooldown is over.
    r.outcomes.turnStarted('A');
    r.outcomes.turnEnded('A', { kind: 'done', text: 'ok' });
    expect(r.continued).toEqual(['A', 'A', 'B', 'C', 'D']);
    expect(r.outcomes.coolingDown('cc')).toBe(false);
    expect(r.over).toEqual(['cc']);
    expect(r.needs).toEqual(['A']);
  });

  it('when the probe spends the agent’s budget, everything waiting with it is the person’s', () => {
    const r = many(config({ on: ['limit'], max: 2, backoffMs: 1_000 }));
    for (const id of ['A', 'B', 'C']) r.outcomes.turnEnded(id, limit());
    for (let i = 0; i < 2; i++) {
      r.clock.advance(10_000);
      r.outcomes.turnStarted('A');
      r.outcomes.turnEnded('A', limit());
    }
    expect(r.continued).toEqual(['A', 'A']);
    expect(r.needs.sort()).toEqual(['A', 'B', 'C']);
    expect(r.outcomes.activityOf('B')?.retry).toBeUndefined();
    expect(r.said.filter(([t]) => t === 'B').at(-1)?.[1]).toContain('Not continuing: cc stayed over its usage limit through 2 automatic continues');
    // Two continues in all, not two per conversation; the cooldown stays for the cards until it runs out.
    r.clock.advance(60_000);
    expect(r.continued).toEqual(['A', 'A']);
    expect(r.outcomes.coolingDown('cc')).toBe(false);
    expect(r.over).toEqual(['cc']);
  });

  it('any turn on the agent that ends normally lifts it', () => {
    const r = many(config({ on: ['limit'], backoffMs: 30_000 }));
    r.outcomes.turnEnded('A', limit());
    r.outcomes.turnEnded('B', limit());
    r.outcomes.turnStarted('Z');
    r.outcomes.turnEnded('Z', { kind: 'done', text: 'fine' });
    expect(r.continued).toEqual(['A', 'B']);
    expect(r.outcomes.coolingDown('cc')).toBe(false);
  });

  it('a probe that fails for another reason got past the limit, so the others go', () => {
    const r = many(config({ on: ['limit', 'service'], backoffMs: 1_000 }));
    r.outcomes.turnEnded('A', limit());
    r.outcomes.turnEnded('B', limit());
    r.clock.advance(1_000);
    expect(r.continued).toEqual(['A']);
    r.outcomes.turnStarted('A');
    r.outcomes.turnEnded('A', fail('service'));
    expect(r.continued).toEqual(['A', 'B']);
    expect(r.outcomes.coolingDown('cc')).toBe(false);
    expect(r.outcomes.activityOf('A')?.retry).toBeDefined(); // its own continue, for its own reason
  });

  it('the person acting in a waiting conversation takes it out of the line; in the probe, hands the try on', () => {
    const r = many(config({ on: ['limit'], backoffMs: 1_000 }));
    for (const id of ['A', 'B', 'C']) r.outcomes.turnEnded(id, limit());
    r.outcomes.personActed('B');
    expect(r.outcomes.activityOf('B')?.retry).toBeUndefined();
    r.clock.advance(1_000);
    expect(r.continued).toEqual(['A']);
    r.outcomes.turnStarted('A');
    r.outcomes.personActed('A'); // a /stop in the probe
    r.outcomes.turnEnded('A', { kind: 'stopped' });
    r.clock.advance(1_000);
    expect(r.continued).toEqual(['A', 'C']);
  });

  it('cools an agent down with no continue policy too, for the cards that would land on it', () => {
    const r = many(config());
    r.outcomes.turnEnded('A', limit());
    expect(r.outcomes.coolingDown('cc')).toBe(true);
    expect(r.needs).toEqual(['A']);
    expect(r.said).toEqual([]);
    r.clock.advance(60_000);
    expect(r.outcomes.coolingDown('cc')).toBe(false);
    expect(r.over).toEqual(['cc']);
    expect(r.continued).toEqual([]);
  });
});

describe('TurnOutcomes — a prompt the agent never received', () => {
  it('says so in what the card and the library quote', () => {
    const r = rig(config());
    r.outcomes.turnEnded(ID, { ...fail('startup', 'agent "ag" started, but session/new got no answer within 30s.'), undelivered: { held: 1 } });
    expect(r.outcomes.failureOf(ID)?.text).toBe(
      'agent "ag" started, but session/new got no answer within 30s.\nThe agent did not receive this — it will be sent along with the next message.'
    );
  });
});

describe('TurnOutcomes — turns the last daemon never finished', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('marks a turn on disk while it runs, and clears it when it ends', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'outcomes-'));
    const store = new ConversationStore(path.join(dir, 'conversations.json'));
    store.bind(ID, 'cc');
    const r = rig(config(), store);
    r.outcomes.turnStarted(ID);
    expect(new ConversationStore(path.join(dir, 'conversations.json')).entries()[0]?.[1].inFlight).toBe(1_000);
    r.outcomes.turnEnded(ID, { kind: 'done', text: 'x' });
    expect(new ConversationStore(path.join(dir, 'conversations.json')).entries()[0]?.[1].inFlight).toBeUndefined();
  });

  it('says so where the turn ran, lists it as failed with reason `restart`, and continues it if told to', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'outcomes-'));
    const file = path.join(dir, 'conversations.json');
    const before = new ConversationStore(file);
    before.bind(ID, 'cc');
    before.recordLane(ID, 'cc', 'web', LANE.address, 500);
    before.setInFlight(ID, 600);

    const store = new ConversationStore(file);
    const r = rig(config({ on: ['restart'], backoffMs: 1_000 }), store);
    const ensured: string[] = [];
    expect(r.outcomes.recoverInterrupted((id) => (ensured.push(id), true))).toBe(1);
    expect(ensured).toEqual([ID]);
    expect(r.said[0]).toContain('The gateway restarted before this turn finished');
    expect(r.last()?.outcome?.reason).toBe('restart');
    expect(r.last()?.retry?.attempt).toBe(1);
    expect(new ConversationStore(file).entries()[0]?.[1].inFlight).toBeUndefined();
    r.clock.advance(1_000);
    expect(r.continued).toEqual(['continue']);
  });
});
