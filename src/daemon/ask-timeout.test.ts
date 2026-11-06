import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Daemon } from './daemon.js';
import { PROPOSAL_GATHER_MS } from './delegation.js';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type {
  AgentElicitation,
  ButtonInteraction,
  ElicitAnswer,
  InboundMessage,
} from '../types.js';
import {
  DEFAULT_ASK_REMINDER_MS,
  DEFAULT_ASK_REMINDER_TEXT,
  DEFAULT_ASK_TIMEOUT_MS,
} from '../ipc/protocol.js';

const parsed = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' } },
  agents: [{ id: 'cc', harness: 'claude' }],
  routing: { default: 'cc' },
});
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };

const ONE_QUESTION: AgentElicitation = {
  message: 'Question',
  questions: [
    {
      key: 'q0',
      prompt: 'Pick one',
      options: [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      customKey: 'q0_custom',
      multi: false,
    },
  ],
};

function rig() {
  const sent: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }>; opts?: { kind?: string } }> = [];
  const buttonEdits: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const answers: ElicitAnswer[] = [];
  const sessions = new Map<string, AgentSession>();
  let pendingForm: AgentElicitation | undefined;
  const disposed: string[] = [];

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (_input: { prompt: string }, handlers: AgentStreamHandlers) => {
            const form = pendingForm;
            pendingForm = undefined;
            if (form) answers.push(await handlers.onElicit!(form));
          },
          abort: () => {},
          reclaimState: () => 'resumable',
          dispose: () => void disposed.push(conversationId),
        } as unknown as AgentSession;
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
      thread: true,
      editMessage: true,
      editButtons: true,
      buttons: true,
      reaction: true,
      reply: true,
      slashCommands: true,
      typing: true,
      maxMessageLength: 4096,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (
      address: { channel: string },
      text: string,
      buttons: Array<{ id: string; label: string }>,
      _screen?: unknown,
      opts?: { kind?: string }
    ) => {
      buttonSends.push({ text, buttons, ...(opts?.kind ? { opts } : {}) });
      return { address, messageId: `b${buttonSends.length}` };
    },
    editButtons: async (
      _ref: { messageId: string },
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonEdits.push({ text, buttons });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
    // Both present, so `commandSurface(adapter).nested` is true and task-new can reach putUp —
    // which is where the confirmation card's kind is decided.
    parentOf: () => undefined,
    childrenOf: () => [],
  } as unknown as PlatformAdapter;

  const daemon = new Daemon(
    cfg,
    new Map([['tg', platform]]),
    agents,
    '/tmp/aa-ask-timeout-test.sock'
  );

  let n = 0;
  return {
    daemon,
    sent,
    buttonSends,
    buttonEdits,
    answers,
    disposed,
    ask: (form: AgentElicitation) => {
      pendingForm = form;
    },
    send: async (text: string) => {
      const msg: InboundMessage = {
        conversation: CONVERSATION,
        messageId: `in_${++n}`,
        content: text,
        timestamp: Date.now(),
      };
      (daemon as unknown as { onInbound: (m: InboundMessage) => void }).onInbound(msg);
      await vi.advanceTimersByTimeAsync(50);
    },
    click: async (buttonId: string) => {
      const ev: ButtonInteraction = {
        buttonId,
        conversation: CONVERSATION,
        messageId: 'b1',
      };
      (daemon as unknown as { onButton: (ev: ButtonInteraction) => void }).onButton(ev);
      await vi.advanceTimersByTimeAsync(50);
    },
  };
}

describe('ask question reminders, timeouts, and session reclaim', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a reminder message after 30 minutes of no reply', async () => {
    const r = rig();
    r.ask(ONE_QUESTION);
    await r.send('hello');

    expect(r.buttonSends).toHaveLength(1);
    expect(r.sent).not.toContain(DEFAULT_ASK_REMINDER_TEXT);

    // Advance to 29 minutes: reminder not yet sent
    await vi.advanceTimersByTimeAsync(DEFAULT_ASK_REMINDER_MS - 60_000);
    expect(r.sent).not.toContain(DEFAULT_ASK_REMINDER_TEXT);

    // Advance to 30 minutes: reminder is sent
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toContain(DEFAULT_ASK_REMINDER_TEXT);

    // Question is still active (not timed out yet)
    expect(r.answers).toHaveLength(0);
    expect(r.buttonEdits).toHaveLength(0);
  });

  it('settles ask as timed out and reclaims the agent session after 1 hour', async () => {
    const r = rig();
    r.ask(ONE_QUESTION);
    await r.send('hello');

    expect(r.disposed).toHaveLength(0);

    // Advance through the full 1 hour timeout
    await vi.advanceTimersByTimeAsync(DEFAULT_ASK_TIMEOUT_MS);

    // Question settled as cancelled
    expect(r.answers).toEqual([{ action: 'cancel' }]);
    expect(r.buttonEdits.at(-1)?.text).toContain('(timed out)');
    expect(r.buttonEdits.at(-1)?.buttons).toEqual([]);

    // Turn completes and triggers session reclaim
    expect(r.disposed).toEqual(['tg#c1#']);
  });

  it('does not send reminder if user clicked an option before 30 minutes', async () => {
    const r = rig();
    r.ask(ONE_QUESTION);
    await r.send('hello');

    expect(r.buttonSends).toHaveLength(1);
    const buttonId = r.buttonSends[0]!.buttons[0]!.id;

    // User clicks option A at 10 minutes
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await r.click(buttonId);

    expect(r.answers).toEqual([{ action: 'accept', content: { q0: 'a' } }]);

    // Advance past 30 minutes and 1 hour
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    // No reminder sent and no timeout reclaim
    expect(r.sent).not.toContain(DEFAULT_ASK_REMINDER_TEXT);
    expect(r.disposed).toHaveLength(0);
  });

  it('does not send reminder if user typed an answer before 30 minutes', async () => {
    const r = rig();
    r.ask(ONE_QUESTION);
    await r.send('hello');

    // User types text answer at 5 minutes
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await r.send('my typed answer');

    expect(r.answers).toEqual([{ action: 'accept', content: { q0_custom: 'my typed answer' } }]);

    // Advance past 30 minutes
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(r.sent).not.toContain(DEFAULT_ASK_REMINDER_TEXT);
  });

  it('gives a sub-agent update the whole question, not its first line', async () => {
    const r = rig();
    const prompt = `${'Q'.repeat(200)}\n\nsecond line\n- an option`;
    r.ask({
      message: 'Question',
      questions: [{ key: 'q0', prompt, options: [{ label: 'A', value: 'a' }], customKey: 'q0_custom', multi: false }],
    });
    await r.send('hello');
    expect(r.buttonSends).toHaveLength(1);
    const questionOf = (r.daemon as unknown as { questionOf(id: string): string | undefined }).questionOf.bind(r.daemon);
    expect(questionOf('tg#c1#')).toBe(prompt);
  });

  it('marks the sub-agent confirmation card as a dispatch, through askButtons', async () => {
    // delegation.ts's confirm is the Daemon's own askButtons call, so this is the one path where
    // the card's kind can be checked end to end. Unmarked, the page draws it as an ordinary
    // question rather than the hand-off it is.
    const r = rig();
    await r.send('hello');
    const delegation = (
      r.daemon as unknown as {
        delegation: { handle: (id: string, a: { kind: 'task-new'; agent: string; text: string }) => Promise<unknown> };
      }
    ).delegation;
    await delegation.handle('tg#c1#', { kind: 'task-new', agent: 'cc', text: 'refactor the parser' });
    await vi.advanceTimersByTimeAsync(PROPOSAL_GATHER_MS + 500);

    const card = r.buttonSends.at(-1);
    expect(card?.text).toContain('wants to start a sub-agent');
    expect(card?.opts).toEqual({ kind: 'dispatch' });
  });
});
