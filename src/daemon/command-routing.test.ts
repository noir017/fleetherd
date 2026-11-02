import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * Generic-command interception in SessionRegistry.route().
 *
 * These pin the behavior of a real two-harness deployment (`cc` = claude, `oc` = opencode), where
 * registering the union of agent-reported commands misfired three ways: whichever harness last
 * built a session overwrote the menu, same-named commands from different harnesses collided, and an
 * agent-specific command invoked from the menu ran on `routing.default` instead of the agent that
 * offered it. One config-derived menu plus an explicit refusal per harness replaces all three.
 *
 * The assertions that matter are the negative ones — a rejected command must NOT reach the merger
 * and must NOT emit a header, because both would announce a turn that never happens.
 *
 * Configs go through the real parseConfig rather than a hand-built object: the runtime reads keys
 * (stream/tools/inbound) that only the schema's defaults supply, so a literal would silently differ
 * from what the daemon actually runs.
 */

/** Build a runtime Config from the user-facing subset, exactly as loading a config.yaml would. */
const makeConfig = (over: Record<string, unknown> = {}): Config => {
  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'oc', harness: 'opencode' },
    ],
    routing: {
      default: 'cc',
      pipeline: [
        { when: { command: 'oc' }, use: { agent: 'oc' } },
        { when: { command: 'cc' }, use: { agent: 'cc' } },
      ],
    },
    display: { header: { enabled: true } },
    ...over,
  });
  // Shrink the merge window so a routed message dispatches promptly. Applied to the PARSED object
  // rather than the input: `inbound` belongs to the frozen EXPERIENCE block, which parseConfig
  // spreads over the user config, so passing it above would be silently discarded.
  return { ...cfg, inbound: { ...cfg.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
};

const baseConfig = makeConfig();

/**
 * The conversation every rig message belongs to. Note what is NOT in it: an agent id. Under the
 * old scheme this was `cc:discord:c:c1` or `oc:discord:c:c1` depending on who answered, which is
 * exactly why `/oc hi` followed by a plain message produced two conversations in one place.
 */
const KEY = 'discord#c1#'; // per_thread (the default): the trailing field is the empty lane

/**
 * Real timers, with the merge window set to 0 in config below so a routed message dispatches on the
 * next tick. Firing every scheduled callback inline is not an option: the typing keep-alive
 * re-schedules itself, so it would recurse until the stack blew.
 */
const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** Let the merge window elapse and the turn reach the agent stub. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/**
 * Rig: records outbound text, the prompts that reached an agent, and picker hook calls.
 *
 * The store stub is stateful, because the agent-switch lock reads it: `persistedAgent` and
 * `persistedSessions` simulate what a previous daemon run left in conversations.json, and with
 * `startsSessions` every turn records a session id for the agent that ran it — which is what the
 * real runtimes do at `session/new`, and the condition that locks a topic to its agent.
 */
function rig(
  cfg: Config = baseConfig,
  persistedAgent?: string,
  opts: { persistedSessions?: Record<string, string>; startsSessions?: boolean; nested?: boolean } = {}
) {
  const prompts: Array<{ sessionId: string; agentId: string; prompt: string }> = [];
  const sessions = new Map<string, AgentSession>();
  let bound = persistedAgent;
  let agentSessions: Record<string, string> = { ...(opts.persistedSessions ?? {}) };
  const factory: AgentFactory = {
    getOrCreate(conversationId, agentId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => {
            prompts.push({ sessionId: conversationId, agentId, prompt: input.prompt });
            if (opts.startsSessions) agentSessions[agentId] = `sess-${agentId}`;
          },
          abort: () => {},
          dispose: () => {},
        };
        sessions.set(conversationId, s);
      }
      return s!;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const sent: string[] = [];
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
    // What makes a platform able to hold sub-agents (delegation.ts commandSurface); the web UI's.
    ...(opts.nested ? { parentOf: () => undefined, childrenOf: () => [] } : {}),
  } as unknown as PlatformAdapter;

  const pickerCalls: Array<{ sessionId: ConversationId; agentId: string }> = [];
  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    { onPickerRequest: (sessionId, agentId) => void pickerCalls.push({ sessionId, agentId }) },
    // Store stub, stateful for the switch lock (see the rig's doc).
    {
      boundAgent: () => bound,
      bind: (_k: string, agentId: string) => {
        bound = agentId;
      },
      agentSession: (_k: string, agentId: string) => agentSessions[agentId],
      setAgentSession: () => {},
      clear: () => {
        bound = undefined;
        agentSessions = {};
      },
      conversationCwd: () => undefined,
      setConversationCwd: () => {},
      clearAgentSessions: () => {
        agentSessions = {};
      },
      // Naming reads these on the way into every turn; a stub without them would fail the turn.
      conversationTitle: () => undefined,
      titlePinned: () => false,
      setConversationTitle: () => {},
    } as never
  );

  let n = 0;
  /**
   * Route one message and let the turn reach the agent. TurnRunner awaits several times before
   * calling runTurn (channel resolution, attachment ingest), so the synchronous route() call alone
   * would finish before any prompt is recorded.
   */
  const send = async (content: string): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };

  const headers = (): string[] => sent.filter((t) => t.startsWith('🤖'));
  return { reg, sent, send, prompts, pickerCalls, headers };
}

describe('generic command translation in route()', () => {
  it('rejects a generic command the target harness has no equivalent for, without running a turn', async () => {
    const { send, sent, prompts, headers } = rig();
    // Probed live: opencode reports only customize-opencode/init/review — no compact.
    await send('/oc /compact');
    expect(sent.some((t) => t.includes('does not support /compact'))).toBe(true);
    // The two negatives that matter: no turn, and no header announcing one.
    expect(prompts).toEqual([]);
    expect(headers()).toEqual([]);
  });

  it('names the harness (not the config id) and points at its own command list', async () => {
    const { send, sent } = rig();
    await send('/oc /mcp');
    const msg = sent.find((t) => t.includes('does not support'))!;
    // `oc` is an operator's typing shorthand and means nothing to a reader.
    expect(msg).toContain('opencode does not support /mcp');
    // The hint names the REGISTERED command, which is the short form — pointing at `/opencode`
    // would send the user to a name that is no longer in the menu.
    expect(msg).toContain('/oc');
    expect(msg).not.toContain('/opencode');
  });

  it('forwards a supported generic command to the routed agent', async () => {
    const { send, prompts } = rig();
    await send('/cc /compact');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY);
    expect(prompts[0]!.prompt).toContain('/compact');
  });

  it('a plain generic command follows normal routing (routing.default), like any other message', async () => {
    const { send, prompts } = rig();
    await send('/compact');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY); // answered by routing.default, in the same conversation
  });

  it('passes through harness-specific commands typed directly', async () => {
    const { send, prompts } = rig();
    await send('/oc /customize-opencode');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY);
    expect(prompts[0]!.prompt).toContain('/customize-opencode');
  });

  it('rewrites to the native spelling where the harness differs, keeping the argument', async () => {
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [{ id: 'gm', harness: 'gemini', args: [], env: {} }],
      routing: { default: 'gm', pipeline: [] },
    } as unknown as Config;
    const { send, prompts } = rig(cfg);
    await send('/compact please');
    // gemini spells it `compress`; the argument survives the rewrite.
    expect(prompts[0]!.prompt).toContain('/compress please');
    expect(prompts[0]!.prompt).not.toContain('/compact');
  });

  it('leaves ordinary messages untouched', async () => {
    const { send, prompts } = rig();
    await send('hello there');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toContain('hello there');
  });

  it('still intercepts /new before translation (daemon commands win)', async () => {
    const { send, prompts, sent } = rig();
    await send('/new');
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('Context cleared'))).toBe(true);
  });
});

/**
 * `/super`, the one generic command whose availability is the PLATFORM's: sub-agents open as topics
 * nested under the one that asked, and only a platform that records which topic opened which (the
 * web UI's parentOf/childrenOf) can show them.
 */
describe('/super depends on the platform, not the harness', () => {
  it('is forwarded unchanged where topics nest — the skill of that name is what reads it', async () => {
    const { send, prompts } = rig(baseConfig, undefined, { nested: true });
    await send('/super split the upgrade across the two repos');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.agentId).toBe('cc');
    expect(prompts[0]!.prompt).toContain('/super split the upgrade across the two repos');
  });

  it('is refused by name elsewhere, with no turn — every harness would end at the same refusal', async () => {
    const { send, prompts, sent, headers } = rig();
    await send('/super split the upgrade across the two repos');
    expect(prompts).toEqual([]);
    expect(headers()).toEqual([]);
    expect(sent.at(-1)).toContain('/super works in the web UI only');
  });

  it('still says a harness that cannot read the skill does not support it, where topics nest', async () => {
    const cfg = makeConfig({ agents: [{ id: 'cc', harness: 'claude' }, { id: 'gm', harness: 'gemini' }], routing: { default: 'gm' } });
    const { send, prompts, sent } = rig(cfg, undefined, { nested: true });
    await send('/super split it');
    expect(prompts).toEqual([]);
    expect(sent.at(-1)).toContain('gemini does not support /super');
  });
});

/**
 * The bare form of an agent command.
 *
 * `/oc <prompt>` picks who answers; `/oc` alone has nothing to ask, so it doubles as the way into
 * that harness's OWN commands — which are deliberately never registered globally, making this the
 * only route to them. It replaces the old `/opencode` picker, whose name was the harness enum value
 * leaking into the UI and which refused to work unless the conversation was already on that harness.
 */
describe('bare agent command → harness picker', () => {
  it('hands off to the daemon with the conversation it was invoked for', async () => {
    const { send, pickerCalls, prompts } = rig();
    await send('/cc');
    expect(pickerCalls).toEqual([{ sessionId: KEY, agentId: 'cc' }]);
    expect(prompts).toEqual([]); // the picker is UI, never a prompt
  });

  it('switches first when the conversation has no session yet, then offers ITS commands', async () => {
    // The old picker answered "does not apply here, switch with /<agent> first" — advice the
    // command itself can follow, since a bare `/oc` is also how you choose. Only while there is no
    // session to strand, though: see "a topic keeps its agent" below for the locked case.
    const { send, pickerCalls, prompts } = rig();
    await send('/cc hello'); // bind to claude
    await send('/oc');
    expect(pickerCalls).toEqual([{ sessionId: KEY, agentId: 'oc' }]);
    expect(prompts).toHaveLength(1); // only the first message ran a turn
  });

  it('an agent command for an unconfigured harness names the gap instead of running a turn', async () => {
    // The regression this pins: `/agy hi` in a deployment with no agy agent resolved to nobody, so
    // the prefix survived and the message reached the BOUND agent spelled `/agy hi` — which it ran
    // as one of its own slash commands, found nothing, and answered "ran a command, no output".
    const cfg = makeConfig({
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc', pipeline: [] },
    });
    const { send, sent, pickerCalls, prompts } = rig(cfg);
    await send('/agy hi'); // agy isn't configured here
    expect(sent.some((t) => t.includes('No agy agent is configured'))).toBe(true);
    // The negatives that matter: no turn, and no picker for a harness that isn't there.
    expect(prompts).toEqual([]);
    expect(pickerCalls).toEqual([]);
  });

  it('the bare form of an unconfigured harness is answered the same way', async () => {
    const cfg = makeConfig({
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc', pipeline: [] },
    });
    const { send, sent, prompts } = rig(cfg);
    await send('/opencode'); // the full-name alias, equally unconfigured
    expect(sent.some((t) => t.includes('No opencode agent is configured'))).toBe(true);
    expect(prompts).toEqual([]);
  });

  it('a `when.command` rule still outranks the unconfigured check', async () => {
    // An operator may point any name at any agent; the check only covers names nothing claimed.
    const cfg = makeConfig({
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc', pipeline: [{ when: { command: 'agy' }, use: { agent: 'cc' } }] },
    });
    const { send, sent, prompts } = rig(cfg);
    await send('/agy hi');
    expect(sent.some((t) => t.includes('is configured'))).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toContain('hi');
  });

  it('a harness that reports no command list acks the binding instead of an empty menu', async () => {
    // agy runs with --disable-slash-commands and reports nothing, so a picker could only ever say
    // "none yet". It still earns a command, because switching to it is the useful half.
    const cfg = makeConfig({
      agents: [
        { id: 'cc', harness: 'claude' },
        { id: 'g', harness: 'agy' },
      ],
      routing: { default: 'cc', pipeline: [] },
    });
    const { send, sent, pickerCalls, prompts } = rig(cfg);
    await send('/agy');
    expect(pickerCalls).toEqual([]);
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('answered by agy'))).toBe(true);
  });
});

/**
 * Agent commands resolve from the harness table, not only from `routing.pipeline`.
 *
 * Registration is per configured harness, so before this a freshly installed deployment
 * advertised `/cc` and `/oc` in the platform menu while the daemon knew nothing about them —
 * tapping one forwarded the literal text "/oc" to whichever agent happened to be bound.
 */
describe('built-in agent command resolution', () => {
  /** Same two harnesses as baseConfig, but with no command rules wired by hand. */
  const noPipeline = makeConfig({ routing: { default: 'cc', pipeline: [] } });

  it('routes to the harness the command names with no pipeline rule at all', async () => {
    const { send, prompts, sent } = rig(noPipeline);
    await send('/oc hello');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toContain('hello');
    expect(prompts[0]!.prompt).not.toContain('/oc'); // the prefix is consumed, not forwarded
    expect(sent.some((t) => t.includes('🤖 opencode'))).toBe(true);
  });

  it('the pre-rename full harness name still resolves when typed', async () => {
    const { send, sent } = rig(noPipeline);
    await send('/opencode hello');
    expect(sent.some((t) => t.includes('🤖 opencode'))).toBe(true);
  });

  it('a hand-written pipeline command rule outranks the built-in table', async () => {
    // An operator who points /oc at a second claude agent gets that, not the first opencode one.
    const cfg = makeConfig({
      agents: [
        { id: 'cc', harness: 'claude' },
        { id: 'oc', harness: 'opencode' },
        { id: 'other', harness: 'claude' },
      ],
      routing: { default: 'cc', pipeline: [{ when: { command: 'oc' }, use: { agent: 'other' } }] },
    });
    const { send, sent } = rig(cfg);
    await send('/oc hello');
    expect(sent.some((t) => t.includes('🤖 claude'))).toBe(true);
  });

  it('`/agy <prompt>` reaches the agy agent with the prefix consumed', async () => {
    // The user-reported case, end to end: agy has no picker, so this is the ONLY form that runs a
    // turn on it, and a surviving `/agy` prefix is exactly what made it look inert.
    const cfg = makeConfig({
      agents: [
        { id: 'cc', harness: 'claude' },
        { id: 'g', harness: 'agy' },
      ],
      routing: { default: 'cc', pipeline: [] },
    });
    const { send, prompts, sent } = rig(cfg);
    await send('/agy hi');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toContain('hi');
    expect(prompts[0]!.prompt).not.toContain('/agy');
    expect(sent.some((t) => t.includes('🤖 agy'))).toBe(true);
  });

  it('an agent command outranks a rule that merely matched on where the message came from', async () => {
    // The platform rule supplies the conversation's default answerer; naming an agent is an
    // instruction, so it wins.
    const cfg = makeConfig({
      routing: { default: 'cc', pipeline: [{ when: { platform: 'discord' }, use: { agent: 'cc' } }] },
    });
    const { send, sent } = rig(cfg);
    await send('/oc hello');
    expect(sent.some((t) => t.includes('🤖 opencode'))).toBe(true);
  });
});

/** `/help` is answered by the gateway: it is the only place the registered vocabulary is explained. */
describe('/help', () => {
  it('answers from the gateway and runs no turn', async () => {
    const { send, sent, prompts } = rig();
    await send('/help');
    expect(prompts).toEqual([]);
    const help = sent.find((t) => t.includes('/new'))!;
    expect(help).toContain('/cc');
    expect(help).toContain('/oc');
    expect(help).toContain('/help');
  });

  it('reports the generic commands of the agent answering right now', async () => {
    const { send, sent } = rig();
    await send('/oc hello'); // bind to opencode
    await send('/help');
    const help = sent.find((t) => t.includes('/new'))!;
    expect(help).toContain('Answering now: **opencode**');
    // opencode has no compact, so listing it would be a promise the next tap breaks.
    expect(help).not.toContain('/compact');
  });

  it('composes with an agent prefix, like /new does', async () => {
    const { send, sent, prompts } = rig();
    await send('/cc /help');
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('Answering now: **claude**'))).toBe(true);
  });
});

describe('dispatchTo', () => {
  it('delivers to the named conversation, bypassing routing', async () => {
    const { reg, send, prompts } = rig();
    await send('/oc hello'); // bind this conversation to oc
    prompts.length = 0;

    // A bare /init carries no agent prefix, so re-routing it would resolve against the pipeline
    // instead of the conversation's bound agent — the misdelivery this path removes.
    const ok = reg.dispatchTo(KEY, {
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: 'click',
      content: '/init',
      timestamp: 0,
    } as InboundMessage);

    expect(ok).toBe(true);
    await drain(); // the merger dispatches on its own window, as for any inbound
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY);
    expect(prompts[0]!.prompt).toContain('/init');
  });

  it('reports failure for an unknown conversation instead of dropping the message', async () => {
    const { reg } = rig();
    const ok = reg.dispatchTo('discord#nope#', {
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: 'click',
      content: '/init',
      timestamp: 0,
    } as InboundMessage);
    expect(ok).toBe(false);
  });
});

/**
 * THE reported bug, pinned end to end.
 *
 * Screenshot: in one Telegram topic, `/oc hi` was answered by opencode and the very next plain
 * message by claude. Cause: the agent id led the session key AND the pipeline was re-resolved on
 * every message, so a follow-up that matched no rule fell through to routing.default and computed
 * a different key — a different subprocess with empty context.
 *
 * These assert the two halves of the fix together: one conversation key throughout, and the bound
 * agent answering until the user explicitly names another.
 */
describe('sticky agent binding (the reported bug)', () => {
  it('a plain follow-up stays with the agent the conversation was bound to', async () => {
    const { send, prompts } = rig();

    await send('/oc hi');
    await send('second turn');

    expect(prompts).toHaveLength(2);
    // Same conversation both times — this is what used to differ.
    expect(prompts.map((p) => p.sessionId)).toEqual([KEY, KEY]);
    // And the same agent process serves both, so the second turn has the first one's context.
    expect(prompts[1]!.prompt).toContain('second turn');
  });

  it('an explicit /name still chooses while no session exists, and the next plain message follows it', async () => {
    // The rig's agents record no session id, so nothing locks the topic yet — this is choosing an
    // agent, not switching one (the locked case is its own suite below).
    const { send, prompts, sent } = rig();

    await send('/oc hi');
    await send('/cc take over');
    await send('still you');

    expect(prompts.map((p) => p.sessionId)).toEqual([KEY, KEY, KEY]);
    expect(prompts.map((p) => p.agentId)).toEqual(['oc', 'cc', 'cc']);
    expect(sent.some((t) => t.includes('is answering this conversation now'))).toBe(true);
  });

  it('a bare /name is a binding instruction, not an empty prompt', async () => {
    const { send, prompts, pickerCalls } = rig();
    await send('/oc');
    // No turn: there is nothing to say yet.
    expect(prompts).toEqual([]);
    // It binds, then offers opencode's own commands — the bare form's whole job.
    expect(pickerCalls).toEqual([{ sessionId: KEY, agentId: 'oc' }]);
  });

  it('the conversation key never contains an agent id', async () => {
    const { send, prompts } = rig();
    await send('/oc hi');
    await send('/cc hi');
    for (const p of prompts) {
      expect(p.sessionId).toBe(KEY);
      expect(p.sessionId).not.toMatch(/\b(oc|cc)\b/);
    }
  });
});

/**
 * What happens on the FIRST message after a restart.
 *
 * In-memory state is gone but conversations.json is not, so `route()` has to choose between the
 * persisted binding and whatever this message asks for. Both directions matter and they pull
 * opposite ways, which is why each gets a case.
 */
describe('first message after a restart', () => {
  it('an explicit /cc outranks a persisted binding that never got a session', async () => {
    // The user just said who they want, and nothing is lost by it. Reading the store first would
    // make this message answer as whoever was bound before and ignore its own prefix.
    const { send, sent } = rig(baseConfig, 'oc');
    await send('/cc hello');
    // No rebind notice: this is the conversation's first binding in this run, not a switch.
    expect(sent.some((t) => t.includes('is answering this conversation now'))).toBe(false);
    // The header names who actually took it.
    expect(sent.some((t) => t.includes('🤖 claude'))).toBe(true);
    expect(sent.some((t) => t.includes('🤖 opencode'))).toBe(false);
  });

  it('a plain message resumes the persisted agent, not routing.default', async () => {
    const { send, sent } = rig(baseConfig, 'oc');
    await send('continue where we left off');
    // routing.default is cc; the persisted binding must win.
    expect(sent.some((t) => t.includes('🤖 opencode'))).toBe(true);
    expect(sent.some((t) => t.includes('🤖 claude'))).toBe(false);
  });

  it('a persisted session holds the topic to its agent even with no in-memory state', async () => {
    // The lock reads the store, not the registry's map, precisely so a restart is not a way around it.
    const { send, sent, prompts } = rig(baseConfig, 'oc', { persistedSessions: { oc: 'ses_abc' } });
    await send('/cc hello');
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('does not switch agents') && t.includes('`ses_abc`'))).toBe(true);
  });
});

/**
 * A topic keeps the agent it started with, once that agent has a session there (2026-09-30).
 *
 * Switching in place was possible before and unused in practice; what it produced was a topic whose
 * tag, header and history named one agent while another answered blind. The refusal hands over what
 * the next agent needs instead — its session id and directory — and every case below asserts the
 * negatives too: no turn, no picker, no binding change.
 */
describe('a topic keeps its agent', () => {
  it('refuses /oc in a topic claude has a session in, and says where the session is', async () => {
    const { send, sent, prompts } = rig(baseConfig, undefined, { startsSessions: true });
    await send('/cc hi');
    await send('/oc take over');
    expect(prompts.map((p) => p.agentId)).toEqual(['cc']);
    const refusal = sent.find((t) => t.includes('does not switch agents'))!;
    expect(refusal).toContain('stays with claude');
    expect(refusal).toContain('`sess-cc`');
    // The command to use in the new topic is the registered short form, not the harness name.
    expect(refusal).toContain('`/oc`');
    expect(sent.some((t) => t.includes('is answering this conversation now'))).toBe(false);
  });

  it('keeps answering with the bound agent after a refusal', async () => {
    const { send, prompts } = rig(baseConfig, undefined, { startsSessions: true });
    await send('/cc hi');
    await send('/oc take over');
    await send('carry on');
    expect(prompts.map((p) => p.agentId)).toEqual(['cc', 'cc']);
    expect(prompts[1]!.prompt).toContain('carry on');
  });

  it('refuses the bare form too, without opening the other agent\'s menu', async () => {
    const { send, sent, prompts, pickerCalls } = rig(baseConfig, undefined, { startsSessions: true });
    await send('/cc hi');
    await send('/oc');
    expect(pickerCalls).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(sent.some((t) => t.includes('does not switch agents'))).toBe(true);
  });

  it('naming the agent already bound is not a switch', async () => {
    const { send, sent, prompts } = rig(baseConfig, undefined, { startsSessions: true });
    await send('/cc hi');
    await send('/cc more please');
    expect(prompts.map((p) => p.agentId)).toEqual(['cc', 'cc']);
    expect(sent.some((t) => t.includes('does not switch agents'))).toBe(false);
  });

  it('/new empties the topic, after which any agent can take it', async () => {
    const { send, sent, prompts } = rig(baseConfig, undefined, { startsSessions: true });
    await send('/cc hi');
    await send('/new');
    await send('/oc fresh start');
    expect(prompts.map((p) => p.agentId)).toEqual(['cc', 'oc']);
    expect(sent.some((t) => t.includes('does not switch agents'))).toBe(false);
  });

  it('a daemon command behind the prefix still works — `/oc /new` clears the topic', async () => {
    const { send, sent, prompts } = rig(baseConfig, undefined, { startsSessions: true });
    await send('/cc hi');
    await send('/oc /new');
    expect(sent.some((t) => t.includes('Context cleared'))).toBe(true);
    expect(sent.some((t) => t.includes('does not switch agents'))).toBe(false);
    expect(prompts).toHaveLength(1);
  });
});
