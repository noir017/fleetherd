import { describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, RunTurnInput } from './agent.js';
import type { ButtonInteraction, InboundMessage, MessageRef, ModelSelector } from '../types.js';

/**
 * `/model` on a `custom` harness. Everything typed to one passes through, because nothing is known
 * about a person's own ACP program — except what it declares: an agent whose `session/new` carries a
 * `model` select option gets the gateway's model menu, as a preset does. CodeBuddy is the case that
 * made this a rule (2026-11-05): it declares the option and advertises no commands, so a forwarded
 * `/model` was a prompt it answered with nothing.
 *
 * What is guarded: a cold session is brought up to find out (the same child the forwarded message
 * would have started), the answer is remembered, and an agent with no such option — or one that does
 * not start — still has `/model` forwarded exactly as before.
 */

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
const MENU_MSG = 'menu-msg-id';
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const OPTIONS = [
  { value: 'custom-local:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { value: 'custom-local:glm-5.3', name: 'GLM 5.3' },
];

type Mode = 'declares' | 'none' | 'fails';

function rig(mode: Mode) {
  const sent: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const turns: string[] = [];
  const setModelCalls: string[] = [];
  let ensureCalls = 0;
  const sessions = new Map<string, AgentSession>();
  let warmed = false;
  const selector = (): ModelSelector | undefined =>
    mode === 'declares' && warmed ? { current: OPTIONS[0]!.value, options: [...OPTIONS] } : undefined;

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input: RunTurnInput) => {
            warmed = true; // a turn starts the session as well
            turns.push(input.prompt);
          },
          abort: () => {},
          dispose: () => {},
          modelSelector: selector,
          ensureSession: async () => {
            ensureCalls++;
            if (mode === 'fails') throw new Error('codebuddy: not logged in');
            warmed = true;
          },
          setModel: async (value: string) => {
            setModelCalls.push(value);
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
      buttons: true, editButtons: true,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (address: { channel: string }, text: string, buttons: Array<{ id: string; label: string }>) => {
      buttonSends.push({ text, buttons });
      return { address, messageId: MENU_MSG };
    },
    editButtons: async (_ref: MessageRef) => {},
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cbc', harness: 'custom', command: '/opt/ua/codebuddy/current/bin/codebuddy', args: ['--acp'] }],
    routing: { default: 'cbc' },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, '/tmp/aa-custom-model-test.sock');
  const d = daemon as unknown as { onInbound(m: InboundMessage): void; onButton(ev: ButtonInteraction): void };
  let n = 0;
  const send = async (content: string): Promise<void> => {
    d.onInbound({ conversation: CONVERSATION, messageId: `in${++n}`, content, timestamp: Date.now(), mentionedSelf: true });
    await drain();
  };
  const click = async (buttonId: string): Promise<void> => {
    d.onButton({ conversation: CONVERSATION, messageId: MENU_MSG, buttonId });
    await drain();
  };
  return { send, click, sent, buttonSends, turns, setModelCalls, ensures: () => ensureCalls };
}

describe('/model on a custom harness', () => {
  it('opens the gateway’s menu for an agent that declares a model option, cold included', async () => {
    const r = rig('declares');
    await r.send('/model');
    // Found out by bringing the session up — no turn, no prompt.
    expect(r.ensures()).toBe(1);
    expect(r.turns).toEqual([]);
    expect(r.buttonSends).toHaveLength(1);
    expect(r.buttonSends[0]!.buttons.some((b) => b.label.includes('DeepSeek V4.1 Flash'))).toBe(true);
  });

  it('switches with set_config_option, as for a preset', async () => {
    const r = rig('declares');
    await r.send('/model');
    const pick = r.buttonSends[0]!.buttons.find((b) => b.label.includes('GLM 5.3'))!;
    await r.click(pick.id);
    expect(r.setModelCalls).toEqual(['custom-local:glm-5.3']);
    expect(r.turns).toEqual([]);
  });

  it('answers at once when the session is already up, and by name too', async () => {
    const r = rig('declares');
    await r.send('hello');
    expect(r.turns).toEqual(['hello']);
    await r.send('/model glm');
    expect(r.setModelCalls).toEqual(['custom-local:glm-5.3']);
    expect(r.turns).toEqual(['hello']);
  });

  it('forwards /model, as it always did, to an agent that declares no such option — and remembers', async () => {
    const r = rig('none');
    await r.send('/model');
    expect(r.buttonSends).toEqual([]);
    expect(r.turns).toEqual(['/model']);
    // Decided from what was learned: no second warm-up just to forward the same command.
    await r.send('/model');
    expect(r.ensures()).toBe(1);
    expect(r.turns).toEqual(['/model', '/model']);
  });

  it('forwards it when the agent does not start, so the turn reports why as it would have', async () => {
    const r = rig('fails');
    await r.send('/model');
    expect(r.buttonSends).toEqual([]);
    expect(r.turns).toEqual(['/model']);
  });

  it('leaves every other command to the agent', async () => {
    const r = rig('declares');
    await r.send('/compact');
    expect(r.turns).toEqual(['/compact']);
    expect(r.ensures()).toBe(0);
  });
});
