import { describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ButtonInteraction, InboundMessage, MessageRef } from '../types.js';

/**
 * The picker-click path: a bare `/oc` posts the harness's own commands as buttons, and clicking one
 * must RUN that command in the conversation the menu was posted for.
 *
 * Untested until this file, and it showed: every failure mode on this path was a silent `return`,
 * so a click that went nowhere looked exactly like a click that worked. The two that mattered:
 *  - the ack edit addressed the click's own messageId, which on Telegram is the callback_query id
 *    (not a message) — so the only visible feedback a click had failed to apply, silently;
 *  - an expired menu (one-shot, or a daemon restart) answered nothing at all.
 */

const parsed = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'oc', harness: 'opencode' },
  ],
  routing: { default: 'cc' },
});
// Shrink the merge window so a dispatched message reaches the agent promptly. Applied post-parse:
// `inbound` is part of the frozen EXPERIENCE block and would be discarded from the input.
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
/** What Telegram actually reports on a click: the callback_query id, not a message id. */
const CALLBACK_QUERY_ID = '4242424242424242';

function rig() {
  const prompts: string[] = [];
  const sent: string[] = [];
  const edits: Array<{ messageId: string; text: string }> = [];
  const buttonEdits: Array<{ messageId: string; text: string; buttons: number }> = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const sessions = new Map<string, AgentSession>();

  const agents: AgentFactory = {
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
    platform: 'tg',
    platformType: 'telegram',
    capabilities: {
      thread: true, editMessage: true, buttons: true, reaction: true,
      reply: true, slashCommands: true, typing: true, maxMessageLength: 4096,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (
      address: { channel: string },
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonSends.push({ text, buttons });
      // The first menu keeps the id the older tests pin; later ones get their own.
      return { address, messageId: buttonSends.length === 1 ? 'menu-msg-id' : `menu-msg-id-${buttonSends.length}` };
    },
    editMessage: async (ref: MessageRef, text: string) => {
      edits.push({ messageId: ref.messageId, text });
    },
    editButtons: async (ref: MessageRef, text: string, buttons: unknown[]) => {
      buttonEdits.push({ messageId: ref.messageId, text, buttons: buttons.length });
    },
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, '/tmp/aa-picker-test.sock');
  const d = daemon as unknown as {
    pendingPicks: Map<string, unknown>;
    onInbound(m: InboundMessage): void;
    onAgentCommands(agentId: string, cmds: Array<{ name: string; description?: string }>): void;
    onButton(ev: ButtonInteraction): void;
  };

  let n = 0;
  const send = async (content: string): Promise<void> => {
    d.onInbound({
      conversation: CONVERSATION,
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    await drain();
  };
  /** The command list opencode reports over ACP once a session exists. */
  const reportCommands = (): void =>
    d.onAgentCommands('oc', [
      { name: 'customize-opencode', description: 'configure opencode itself' },
      { name: 'init', description: 'guided AGENTS.md setup' },
      { name: 'review', description: 'review changes' },
    ]);
  const click = async (buttonId: string): Promise<void> => {
    d.onButton({ conversation: CONVERSATION, messageId: CALLBACK_QUERY_ID, buttonId });
    await drain();
  };

  return { send, reportCommands, click, prompts, sent, edits, buttonEdits, buttonSends, pendingPicks: d.pendingPicks };
}

describe('picker button click', () => {
  it('runs the picked command in the conversation the menu was posted for', async () => {
    const { send, reportCommands, click, prompts, buttonSends } = rig();
    reportCommands();
    await send('/oc');

    // init/review are already reachable generically, so only the harness-specific one is offered.
    expect(buttonSends).toHaveLength(1);
    expect(buttonSends[0]!.buttons.map((b) => b.label)).toEqual(['/customize-opencode']);

    await click(buttonSends[0]!.buttons[0]!.id);
    expect(prompts).toContain('/customize-opencode');
  });

  it('acks on the menu message, not on the click event id', async () => {
    const { send, reportCommands, click, edits, buttonSends } = rig();
    reportCommands();
    await send('/oc');
    await click(buttonSends[0]!.buttons[0]!.id);

    // The regression this guards: editing CALLBACK_QUERY_ID is a 400 the caller swallows, so the
    // click produced no visible change whatsoever.
    expect(edits).toContainEqual({ messageId: 'menu-msg-id', text: '→ /customize-opencode' });
    expect(edits.map((e) => e.messageId)).not.toContain(CALLBACK_QUERY_ID);
  });

  it('tells the user when the menu has expired instead of doing nothing', async () => {
    const { send, reportCommands, click, sent, prompts, buttonSends } = rig();
    reportCommands();
    await send('/oc');
    const id = buttonSends[0]!.buttons[0]!.id;

    await click(id); // one-shot: consumes the menu
    const before = prompts.length;
    await click(id); // the same button again — a stale menu

    expect(prompts).toHaveLength(before); // no second turn
    expect(sent.some((t) => t.includes('expired'))).toBe(true);
  });

  it('holds one open menu per conversation: a newer one retires the older, which says so', async () => {
    const { send, reportCommands, click, sent, prompts, buttonEdits, buttonSends, pendingPicks } = rig();
    reportCommands();
    // A picker nobody clicks used to stay in memory for the life of the process, one per bare /oc.
    for (let i = 0; i < 5; i++) await send('/oc');
    expect(buttonSends).toHaveLength(5);
    expect(pendingPicks.size).toBe(1);
    // Each retired menu lost its buttons on the message itself, not just in memory.
    expect(buttonEdits).toHaveLength(4);
    expect(buttonEdits[0]).toEqual({ messageId: 'menu-msg-id', text: 'This menu was replaced by a newer one.', buttons: 0 });

    // A tap on an older menu's button (a platform that kept it) is answered, and runs nothing.
    await click(buttonSends[0]!.buttons[0]!.id);
    expect(prompts).toHaveLength(0);
    expect(sent.some((t) => t.includes('replaced by a newer one'))).toBe(true);
    // The newest still works.
    await click(buttonSends[4]!.buttons[0]!.id);
    expect(prompts).toContain('/customize-opencode');
    expect(pendingPicks.size).toBe(0);
  });
});
