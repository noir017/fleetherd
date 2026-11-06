import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * The slash names agy's own CLI answers, and why they are handled here instead of being forwarded.
 *
 * This is a correctness test before it is a feature test. Forwarded, one of these reaches `agy acp`
 * as an ordinary question for the model — probed on 1.5.1 (2026-11-06): `/usage` got "which kind of
 * usage information are you looking for?" — so the turn is spent and the CLI's real answer never
 * arrives. Before ACP it was worse: on agy 1.2.0 (2026-09-17) the same text made agy set
 * `status:ERROR` and exit 2, ending the session. Either way the assertion that matters in each case
 * below is the negative one: `prompts` stays empty.
 *
 * A skill slash (`/aa-probe`) and an unrecognized one pass through harmlessly (same agy 1.2.0
 * probe), which is why the last test here pins that a non-CLI name still reaches the agent
 * untouched.
 */

const parsed = parseConfig({
  platforms: { discord: { type: 'discord', token: 't' } },
  agents: [{ id: 'agy', harness: 'agy' }],
  routing: { default: 'agy' },
});
const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function rig(cliOutput: { ok: true; output: string } | { ok: false; error: string }) {
  const prompts: string[] = [];
  const sent: string[] = [];
  const ran: string[] = [];
  const sessions = new Map<string, AgentSession>();

  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => void prompts.push(input.prompt),
          abort: () => {},
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
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    undefined,
    undefined,
    undefined,
    async (name, cwd) => {
      ran.push(`${name}@${cwd}`);
      return cliOutput;
    }
  );
  let n = 0;
  const send = async (content: string): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  return { send, prompts, replies, ran };
}

describe('agy’s own CLI commands', () => {
  it('answers /credits from a one-shot process instead of forwarding it', async () => {
    const { send, prompts, replies, ran } = rig({
      ok: true,
      output: 'Remaining credits\t0\nUpgrade\thttps://antigravity.google/g1-upgrade',
    });
    await send('/credits');
    // The whole point: this never became a prompt, so the session is still alive.
    expect(prompts).toEqual([]);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatch(/^credits@/);
    expect(replies().at(-1)).toContain('Remaining credits');
  });

  it('answers /usage through the same path, rendered as quota', async () => {
    // /usage arrives by the other route — the generic vocabulary marks it `local` for agy — and
    // must land in the same place, because it is fatal to the session for the same reason.
    const { send, prompts, replies } = rig({
      ok: true,
      output: 'Gemini Models\tWeekly Limit Remaining\t100%\t2099-01-01T00:00:00Z',
    });
    await send('/usage');
    expect(prompts).toEqual([]);
    expect(replies().at(-1)).toContain('Quota:');
  });

  it('reports why when the CLI could not be run, and still runs no turn', async () => {
    const { send, prompts, replies } = rig({ ok: false, error: 'spawn agy ENOENT' });
    await send('/changelog');
    expect(prompts).toEqual([]);
    expect(replies().at(-1)).toContain('spawn agy ENOENT');
  });

  it('answers /effort itself, without running the CLI at all', async () => {
    // `/effort` is in agy's CLI-answered list, but it is also a generic command — and the generic
    // vocabulary wins: `agy acp` exposes the level as a config option (and `agy -p=/effort` only
    // says "not adjustable"). Forwarding it would spend a turn on a question the CLI owns, so
    // `prompts` staying empty is the assertion that matters. This session offers no selector, so it
    // says so.
    const { send, prompts, replies, ran } = rig({ ok: true, output: 'not adjustable' });
    await send('/effort');
    expect(prompts).toEqual([]);
    expect(ran).toEqual([]);
    expect(replies().at(-1)).toContain('only for its Gemini models');
  });

  it('leaves a skill name alone — it is what the session is meant to expand', async () => {
    const { send, prompts, ran } = rig({ ok: true, output: '' });
    await send('/omp-handoff pick this up');
    expect(ran).toEqual([]);
    expect(prompts).toEqual(['/omp-handoff pick this up']);
  });
});
