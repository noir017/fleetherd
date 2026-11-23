import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage, SteerOutcome } from '../types.js';

/**
 * A message sent while a turn runs, routed end to end through the registry: it is handed to the
 * running turn when the agent can take it there, it waits behind the turn when it cannot, and it
 * never cancels the turn — `/stop` does that, and only `/stop`.
 *
 * The agent is a stub; what is pinned is the gateway's half — what reaches `steer`, what is kept
 * from it, and what runs as the next turn instead.
 */

function config(): Config {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
  });
  // A 1ms merge window: these tests are about what happens mid-turn, not about the merging.
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

const drain = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `steer` undefined = an agent with no way to take input mid-turn (opencode, agy). */
function rig(steer?: SteerOutcome) {
  const prompts: string[] = [];
  const steered: string[] = [];
  let aborts = 0;
  let release: () => void = () => {};
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => {
            prompts.push(input.prompt);
            await new Promise<void>((r) => (release = r));
          },
          ...(steer
            ? {
                steer: async (input: { prompt: string }) => {
                  steered.push(input.prompt);
                  return steer;
                },
              }
            : {}),
          abort: () => {
            aborts += 1;
            release();
          },
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
    sendMessage: async (address: { channel: string }) => ({ address, messageId: 'out' }),
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
  const send = async (content: string, extra: Partial<InboundMessage> = {}): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
      ...extra,
    } as InboundMessage);
    await drain();
  };
  return {
    send,
    prompts,
    steered,
    aborts: () => aborts,
    /** End the running turn, as the agent finishing it would. */
    finish: async () => {
      release();
      await drain();
    },
  };
}

describe('a message sent while the agent is working', () => {
  it('is handed to the running turn when the agent can take it, and the turn is not cancelled', async () => {
    const r = rig('joined');
    await r.send('run the full suite');
    await r.send('also check the docs', { quotedContent: 'the README is stale' });

    expect(r.aborts()).toBe(0);
    // Built exactly like a turn's prompt, quote line included: to the agent it is the user talking.
    expect(r.steered).toEqual(['(replying to: "the README is stale")\nalso check the docs']);

    await r.finish();
    // Answered inside the first turn: nothing runs after it.
    expect(r.prompts).toEqual(['run the full suite']);
  });

  it('waits behind the turn when the agent cannot take input mid-turn, then runs — still no cancel', async () => {
    const r = rig(); // opencode / agy
    await r.send('run the full suite');
    await r.send('also check the docs');
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toEqual(['run the full suite']);

    await r.finish();
    expect(r.prompts).toEqual(['run the full suite', 'also check the docs']);
  });

  it('waits behind the turn when the agent refuses it', async () => {
    const r = rig('refused');
    await r.send('run the full suite');
    await r.send('also check the docs');
    expect(r.steered).toEqual(['also check the docs']);
    await r.finish();
    expect(r.prompts).toEqual(['run the full suite', 'also check the docs']);
  });

  it('keeps a slash command out of the running turn: it runs after, as a command', async () => {
    const r = rig('joined');
    await r.send('run the full suite');
    await r.send('/compact');
    // Offered mid-turn it would be text inside the task; a command has to start a prompt.
    expect(r.steered).toEqual([]);
    await r.finish();
    expect(r.prompts).toEqual(['run the full suite', '/compact']);
  });

  it('is still stopped by /stop, which is now the only thing that cancels a turn', async () => {
    const r = rig('joined');
    await r.send('run the full suite');
    await r.send('/stop');
    expect(r.aborts()).toBe(1);
  });

  it('supports /recall to withdraw a queued message before the turn ends (non-steerable harness)', async () => {
    const r = rig(); // cannot steer mid-turn -> queued behind turn
    await r.send('run the full suite');
    await r.send('actually skip this');
    await r.send('/recall');

    await r.finish();
    expect(r.prompts).toEqual(['run the full suite']);
  });

  it('supports immediate: true to steer immediately without waiting', async () => {
    const r = rig('joined');
    await r.send('run the full suite');
    await r.send('urgent fix', { immediate: true });
    expect(r.steered).toEqual(['urgent fix']);
    await r.finish();
    expect(r.prompts).toEqual(['run the full suite']);
  });
});
