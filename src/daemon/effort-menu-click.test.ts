import { describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ButtonInteraction, EffortSelector, InboundMessage, MessageRef } from '../types.js';

/**
 * `/effort` end to end through the daemon: the typed forms, the menu, and a tap.
 *
 * Built on the model menu's test for the model menu's reason — a menu is a snapshot and a click is a
 * later event, so every way the world can change in between needs its own words. Effort adds one
 * that is ordinary rather than rare: a `/model` in between can reshape the list or remove it, because
 * the levels belong to the model.
 */

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
/** What Telegram actually reports on a click: the callback_query id, not a message id. */
const CALLBACK_QUERY_ID = '4242424242424242';
const MENU_MSG = 'menu-msg-id';

function config(access?: string[]): Config {
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'oc', harness: 'opencode' },
      { id: 'cx', harness: 'codex' },
      { id: 'ag', harness: 'agy' },
      { id: 'gm', harness: 'gemini' },
    ],
    routing: { default: 'cc' },
    ...(access ? { access: { allowFrom: access } } : {}),
  });
  // Post-parse for the reason model-menu-click.test.ts gives: `inbound` is frozen EXPERIENCE.
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const level = (value: string) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) });
/** claude-agent-acp 0.81.0 on opus[1m], as probed. */
const CLAUDE_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(level);

interface RigOptions {
  access?: string[];
  /** Start with no effort levels (a model that offers none). */
  noLevels?: boolean;
  caps?: { buttons?: boolean; editButtons?: boolean };
  /** Make setEffort reject, as a harness refusing the value would. */
  refuse?: string;
}

function rig(opts: RigOptions = {}) {
  const sent: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const buttonEdits: Array<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const setEffortCalls: string[] = [];
  const prompts: string[] = [];
  const sessions = new Map<string, AgentSession>();

  /** Mutable so a test can change the model's levels under an open menu. */
  const selector: { value: EffortSelector | undefined } = {
    value: opts.noLevels ? undefined : { current: 'high', options: [...CLAUDE_LEVELS] },
  };
  const model = { value: 'gpt-6-luna' };

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => void prompts.push(input.prompt),
          abort: () => {},
          dispose: () => {},
          ensureSession: async () => {},
          modelSelector: () => ({ current: model.value, options: [] }),
          effortSelector: () => selector.value,
          setEffort: async (value: string) => {
            if (opts.refuse) throw new Error(opts.refuse);
            setEffortCalls.push(value);
            if (selector.value) selector.value = { ...selector.value, current: value };
            return value;
          },
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: {
      thread: true, editMessage: true, reaction: true, reply: true,
      slashCommands: true, typing: true, maxMessageLength: 4096,
      buttons: opts.caps?.buttons ?? true,
      editButtons: opts.caps?.editButtons ?? true,
      menuPageSize: 12,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (address: { channel: string }, text: string, buttons: Array<{ id: string; label: string }>) => {
      buttonSends.push({ text, buttons });
      return { address, messageId: MENU_MSG };
    },
    editButtons: async (ref: MessageRef, text: string, buttons: Array<{ id: string; label: string }>) => {
      buttonEdits.push({ messageId: ref.messageId, text, buttons });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const daemon = new Daemon(config(opts.access), new Map([['tg', platform]]), agents, '/tmp/aa-effort-menu-test.sock');
  const d = daemon as unknown as {
    onInbound(m: InboundMessage): void;
    onButton(ev: ButtonInteraction): void;
  };

  let n = 0;
  const send = async (content: string, user = 'u1'): Promise<void> => {
    d.onInbound({
      conversation: { ...CONVERSATION, user },
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    await drain();
  };
  const click = async (buttonId: string, user = 'u1'): Promise<void> => {
    d.onButton({ conversation: { ...CONVERSATION, user }, messageId: CALLBACK_QUERY_ID, buttonId });
    await drain();
  };
  /** Text the gateway sent that is not the header bubble. */
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const menu = () => buttonSends.at(-1)!;
  const pickId = (value: string): string => {
    const b = menu().buttons.find((x) => x.label.replace('● ', '') === value);
    if (!b) throw new Error(`no button for ${value}`);
    return b.id;
  };

  return { send, click, replies, menu, pickId, selector, model, sent, buttonSends, buttonEdits, setEffortCalls, prompts };
}

describe('typed /effort', () => {
  it('switches on an exact level, spending no turn', async () => {
    const r = rig();
    await r.send('/effort low');
    expect(r.setEffortCalls).toEqual(['low']);
    expect(r.prompts).toEqual([]);
    expect(r.replies().at(-1)).toContain('Effort set to `low`');
  });

  it('switches on a unique prefix', async () => {
    const r = rig();
    await r.send('/effort x');
    expect(r.setEffortCalls).toEqual(['xhigh']);
  });

  it('asks rather than guesses when a prefix names two levels', async () => {
    const r = rig();
    await r.send('/effort m');
    expect(r.setEffortCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('`medium` · `max`');
  });

  it('names the choices when nothing matches', async () => {
    const r = rig();
    await r.send('/effort turbo');
    expect(r.setEffortCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('No effort level matches "turbo"');
    expect(r.replies().at(-1)).toContain('`max`');
  });

  it('says what the harness refused, instead of pretending it worked', async () => {
    const r = rig({ refuse: 'Invalid params' });
    await r.send('/effort low');
    expect(r.replies().at(-1)).toContain('Could not set effort: Invalid params');
  });
});

describe('a model with no levels', () => {
  it('on codex, names the model and the two ways out', async () => {
    // What this deployment's cx answers today: gpt-6-luna is not in codex-cli 0.155.1's catalog.
    const r = rig({ noLevels: true });
    await r.send('/cx');
    await r.send('/effort');
    const text = r.replies().at(-1)!;
    expect(text).toContain('`gpt-6-luna`');
    expect(text).toContain('model_reasoning_effort');
    expect(r.buttonSends).toHaveLength(0);
  });

  it('on opencode, points at /model — its levels are per model', async () => {
    const r = rig({ noLevels: true });
    r.model.value = 'opencode/mimo-v2.6-flash-free';
    await r.send('/oc');
    await r.send('/effort high');
    expect(r.replies().at(-1)).toContain('reasoning variants');
    expect(r.setEffortCalls).toEqual([]);
  });
});

describe('harnesses without a level', () => {
  // agy had none before `agy acp` (2026-11-06), which offers `thought_level` on its Gemini models.
  it('gemini gets an explicit "not supported", and the session is never written to', async () => {
    const r = rig();
    await r.send('/gm');
    await r.send('/effort high');
    expect(r.prompts).toEqual([]);
    expect(r.setEffortCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('does not support /effort');
  });
});

describe('the menu', () => {
  it('opens on a bare /effort, with the current level marked', async () => {
    const r = rig();
    await r.send('/effort');
    expect(r.buttonSends).toHaveLength(1);
    expect(r.replies()).toEqual([]); // the text surface must not also fire
    expect(r.menu().buttons.map((b) => b.label)).toContain('● high');
  });

  it('answers as text where buttons cannot be edited (LINE, QQ)', async () => {
    const r = rig({ caps: { buttons: true, editButtons: false } });
    await r.send('/effort');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.replies().at(-1)).toContain('Effort: high');
  });

  it('a tap switches, acks on the menu itself, and strips the buttons', async () => {
    const r = rig();
    await r.send('/effort');
    await r.click(r.pickId('max'));
    expect(r.setEffortCalls).toEqual(['max']);
    const ack = r.buttonEdits.at(-1)!;
    expect(ack.messageId).toBe(MENU_MSG); // the captured ref, never the callback_query id
    expect(ack.text).toContain('`max`');
    expect(ack.buttons).toEqual([]);
  });

  it('is one-shot: the same button again says the menu expired', async () => {
    const r = rig();
    await r.send('/effort');
    const id = r.pickId('max');
    await r.click(id);
    await r.click(id);
    expect(r.setEffortCalls).toEqual(['max']);
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('keeps the menu up after a refusal, so a retry is one tap', async () => {
    const r = rig({ refuse: 'Invalid params' });
    await r.send('/effort');
    await r.click(r.pickId('low'));
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.text).toContain('Invalid params');
    expect(edit.buttons.length).toBeGreaterThan(0);
  });

  it('refuses a level the model no longer offers, rather than switching by stale index', async () => {
    // A `/model` between opening and tapping: opencode's new model has no `max`.
    const r = rig();
    await r.send('/effort');
    const id = r.pickId('max');
    r.selector.value = { current: 'default', options: ['minimal', 'low', 'medium', 'high', 'xhigh', 'default'].map(level) };
    await r.click(id);
    expect(r.setEffortCalls).toEqual([]);
    expect(r.buttonEdits.at(-1)!.text).toContain('no longer offered');
    expect(r.buttonEdits.at(-1)!.buttons).toEqual([]);
  });

  it('retires itself when the model it was drawn for offers no levels any more', async () => {
    const r = rig();
    await r.send('/effort');
    const id = r.pickId('low');
    r.selector.value = undefined;
    await r.click(id);
    expect(r.setEffortCalls).toEqual([]);
    expect(r.buttonEdits.at(-1)!.text).toContain('offers no effort levels right now');
    expect(r.buttonEdits.at(-1)!.buttons).toEqual([]);
  });

  it('refuses when another agent has taken over the conversation', async () => {
    const r = rig();
    await r.send('/effort');
    const id = r.pickId('low');
    await r.send('/oc');
    await r.click(id);
    expect(r.setEffortCalls).toEqual([]);
    expect(r.buttonEdits.at(-1)!.text).toContain('answered by');
  });

  it('a second /effort supersedes the first, and the old buttons say so', async () => {
    const r = rig();
    await r.send('/effort');
    const stale = r.pickId('low');
    await r.send('/effort');
    expect(r.buttonEdits[0]!.text).toContain('superseded');
    expect(r.buttonEdits[0]!.buttons).toEqual([]);
    await r.click(stale);
    expect(r.setEffortCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('a mangled index is answered rather than silently dropped', async () => {
    const r = rig();
    await r.send('/effort');
    const reqId = r.pickId('low').split(':')[1]!;
    await r.click(`eff:${reqId}:999`);
    expect(r.setEffortCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('a click from outside the allowlist changes nothing', async () => {
    const r = rig({ access: ['tg:u1'] });
    await r.send('/effort');
    await r.click(r.pickId('low'), 'intruder');
    expect(r.setEffortCalls).toEqual([]);
    expect(r.buttonEdits).toHaveLength(0);
  });
});
