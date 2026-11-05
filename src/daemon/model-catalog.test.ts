import { describe, expect, it } from 'vitest';
import { parseConfig, type AgentDef } from '../config/schema.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ModelSelector } from '../types.js';
import { ModelCatalog } from './model-catalog.js';

/**
 * Any agent's model list, for the settings screen: from a live session if one has it, from what was
 * learned before, or by bringing a session up just to ask — once, put away after, and asked again
 * only when the agent's definition changed or the last ask failed.
 */

const SELECTOR: ModelSelector = { current: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] };

function setup(opts: { selector?: ModelSelector; ensure?: () => Promise<void>; refresh?: () => Promise<void> } = {}) {
  const cfg = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'oc', harness: 'opencode' },
      { id: 'ag', harness: 'agy' },
    ],
    routing: { default: 'oc' },
  });
  const sessions = new Map<string, AgentSession>();
  const created: string[] = [];
  const forgotten: string[] = [];
  let live: ModelSelector | undefined;
  let warmed = false;
  const agents: AgentFactory = {
    getOrCreate(id, agentId) {
      created.push(`${id}→${agentId}`);
      const s = {
        conversationId: id,
        runTurn: async () => {},
        abort: () => {},
        dispose: () => {},
        modelSelector: () => (warmed || !opts.ensure ? opts.selector : undefined),
        ...(opts.ensure
          ? {
              ensureSession: async () => {
                await opts.ensure!();
                warmed = true;
              },
            }
          : {}),
        ...(opts.refresh ? { refreshModels: opts.refresh } : {}),
      } as unknown as AgentSession;
      sessions.set(id, s);
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };
  const catalog = new ModelCatalog({
    agents,
    defOf: (id) => cfg.agents.find((a) => a.id === id),
    liveSelector: () => live,
    tokenFor: (sid) => `tok-${sid}`,
    forget: (sid) => forgotten.push(sid),
  });
  return { cfg, catalog, sessions, created, forgotten, setLive: (s?: ModelSelector) => (live = s) };
}

describe('ModelCatalog', () => {
  it('answers from a live session first, without starting anything', () => {
    const t = setup();
    t.setLive(SELECTOR);
    expect(t.catalog.get('oc')).toEqual({ kind: 'list', options: SELECTOR.options });
    expect(t.catalog.shouldAsk('oc')).toBe(false);
    expect(t.created).toEqual([]);
  });

  it('asks by bringing a session up under its own id, then puts it away', async () => {
    const t = setup({ selector: SELECTOR, ensure: async () => {} });
    expect(t.catalog.get('oc')).toBeUndefined();
    const asking = t.catalog.ask('oc');
    expect(t.catalog.get('oc')).toEqual({ kind: 'loading' });
    expect(await asking).toEqual({ kind: 'list', options: SELECTOR.options });
    expect(t.created).toEqual(['models:oc→oc']);
    expect(t.sessions.size).toBe(0);
    expect(t.forgotten).toEqual(['models:oc']);
    // Kept: the next opening is answered without asking.
    expect(t.catalog.get('oc')).toEqual({ kind: 'list', options: SELECTOR.options });
    expect(t.catalog.shouldAsk('oc')).toBe(false);
  });

  it('asks once however many screens open at the same time', async () => {
    const t = setup({ selector: SELECTOR, ensure: async () => {} });
    const [a, b] = await Promise.all([t.catalog.ask('oc'), t.catalog.ask('oc')]);
    expect(a).toBe(b);
    expect(t.created).toHaveLength(1);
  });

  it('reads a list served outside the session (agy) without starting one', async () => {
    let refreshed = false;
    const t = setup({ selector: SELECTOR, refresh: async () => void (refreshed = true) });
    expect(await t.catalog.ask('ag')).toEqual({ kind: 'list', options: SELECTOR.options });
    expect(refreshed).toBe(true);
  });

  it('says "none" for a harness that offers no model choice', async () => {
    const t = setup({ ensure: async () => {} });
    expect(await t.catalog.ask('oc')).toEqual({ kind: 'none' });
    expect(t.catalog.shouldAsk('oc')).toBe(false);
  });

  it('says why an agent could not be asked, and asks again next time', async () => {
    const t = setup({ ensure: () => Promise.reject(new Error('opencode: command not found\nmore')) });
    expect(await t.catalog.ask('oc')).toEqual({ kind: 'error', reason: 'opencode: command not found' });
    expect(t.catalog.shouldAsk('oc')).toBe(true);
    expect(t.sessions.size).toBe(0);
    expect(t.forgotten).toEqual(['models:oc']);
  });

  it('forgets what it learned when the agent is redefined (a /reload replaces the definition)', async () => {
    const t = setup({ selector: SELECTOR, ensure: async () => {} });
    await t.catalog.ask('oc');
    const i = t.cfg.agents.findIndex((a) => a.id === 'oc');
    t.cfg.agents[i] = { ...(t.cfg.agents[i] as AgentDef) };
    expect(t.catalog.get('oc')).toBeUndefined();
    expect(t.catalog.shouldAsk('oc')).toBe(true);
  });

  it('knows no agent that is not configured', async () => {
    const t = setup();
    expect(t.catalog.get('nope')).toBeUndefined();
    expect(await t.catalog.ask('nope')).toEqual({ kind: 'error', reason: 'no agent named nope' });
  });
});
