import { describe, expect, it, vi } from 'vitest';
import type { AgentFactory, AgentSession } from './agent.js';
import { parseConfig } from '../config/schema.js';

/**
 * Which runtime an agent lands on. Both runtimes are replaced by fakes that only record what they
 * were asked to create, so no agy or ACP child is ever started (the real stream-json factory would
 * run `agy models` at construction).
 */
const made = vi.hoisted(() => ({ acp: [] as string[], agy: [] as string[] }));

function fakeFactory(log: string[]): AgentFactory {
  const sessions = new Map<string, AgentSession>();
  return {
    getOrCreate: (sid, agentId) => {
      let s = sessions.get(sid);
      if (!s) {
        log.push(`${sid}:${agentId}`);
        s = { conversationId: sid } as AgentSession;
        sessions.set(sid, s);
      }
      return s;
    },
    peek: (sid) => sessions.get(sid),
    dispose: (sid) => void sessions.delete(sid),
  };
}

vi.mock('./agent-acp.js', () => ({ createAcpAgentFactory: () => fakeFactory(made.acp) }));
vi.mock('./agent-agy.js', () => ({ createAgyAgentFactory: () => fakeFactory(made.agy) }));

const { createAgentFactory } = await import('./agent-factory.js');

const cfg = parseConfig({
  platforms: { discord: { type: 'discord', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'agy', harness: 'agy' },
    { id: 'agy-old', harness: 'agy', env: { TALKCODE_AGY_RUNTIME: 'stream-json' } },
  ],
  routing: { default: 'cc', pipeline: [] },
});

describe('createAgentFactory', () => {
  it('serves agy over ACP, and over stream-json only where the agent’s env asks for it', () => {
    made.acp.length = 0;
    made.agy.length = 0;
    const f = createAgentFactory(cfg, '/tmp/sock');
    f.getOrCreate('c1', 'cc');
    f.getOrCreate('c2', 'agy');
    f.getOrCreate('c3', 'agy-old');
    expect(made.acp).toEqual(['c1:cc', 'c2:agy']);
    expect(made.agy).toEqual(['c3:agy-old']);
  });

  it('hands back a session from the runtime that holds it, even after the agent moved runtimes', () => {
    made.acp.length = 0;
    made.agy.length = 0;
    const live = structuredClone(cfg);
    const f = createAgentFactory(live, '/tmp/sock');
    const first = f.getOrCreate('c1', 'agy-old');
    // A reload that leaves this conversation on its old definition must not give it a twin.
    live.agents.find((a) => a.id === 'agy-old')!.env = {};
    expect(f.getOrCreate('c1', 'agy-old')).toBe(first);
    expect(made.acp).toEqual([]);
    f.dispose('c1');
    f.getOrCreate('c1', 'agy-old');
    expect(made.acp).toEqual(['c1:agy-old']);
  });
});
