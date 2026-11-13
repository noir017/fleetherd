import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter, SendOptions } from '../platform/adapter.js';
import { SideQuestionRefused, type AgentFactory, type AgentSession, type AgentStreamHandlers } from './agent.js';
import type { InboundMessage, MessageRef } from '../types.js';

/**
 * `/btw` in route(): a side question is answered at once — while a turn runs, without stopping it or
 * queueing behind it — in a message of its own, marked `aside` and sent as a reply to the `/btw`
 * where the platform has replies. What the runtime does with the fork is pinned in
 * agent-acp-btw.test.ts; these pin the gateway's half.
 */

function config(defaultAgent: string): Config {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'ag', harness: 'agy' },
      { id: 'mine', harness: 'custom', command: 'my-acp' },
    ],
    routing: { default: defaultAgent },
  });
  // `inbound` is part of the frozen EXPERIENCE block, so it is set post-parse. Streaming off, so the
  // answer arrives as one message the assertions can read whole.
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 }, stream: { ...parsed.stream, enabled: false } };
}

const drain = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What the stub runtime does when asked a side question. */
type SideScript = (handlers: AgentStreamHandlers, prompt: string) => Promise<'done' | 'stopped'>;

function rig(opts: { agent?: string; side?: SideScript; noSide?: boolean; reply?: 'ok' | 'refused' } = {}) {
  const prompts: string[] = [];
  const asked: string[] = [];
  /** `re` is the message a reply answered; absent on a plain send. */
  const sent: Array<{ text: string; kind?: string; re?: string }> = [];
  let aborts = 0;
  let release: () => void = () => {};
  let stopSide: (() => void) | undefined;

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
          abort: () => {
            aborts += 1;
            release();
          },
          dispose: () => {},
          ...(opts.noSide
            ? {}
            : {
                sideQuestion: async (input: { prompt: string }, handlers: AgentStreamHandlers) => {
                  asked.push(input.prompt);
                  return (opts.side ?? (async (h) => (h.onText('main is on '), h.onText('feat/x'), 'done')))(handlers, input.prompt);
                },
                stopSideQuestions: () => {
                  if (!stopSide) return 0;
                  stopSide();
                  stopSide = undefined;
                  return 1;
                },
              }),
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 4000, reply: opts.reply !== undefined },
    sendMessage: async (address: { channel: string }, text: string, o?: SendOptions) => {
      sent.push({ text, ...(o?.kind ? { kind: o.kind } : {}) });
      return { address, messageId: `out${sent.length}` };
    },
    // The way a native slash command's interaction, or a QQ trigger past its five minutes, answers.
    replyMessage: async (ref: MessageRef, text: string, o?: SendOptions) => {
      if (opts.reply === 'refused') throw new Error('message to be replied not found');
      sent.push({ text, ...(o?.kind ? { kind: o.kind } : {}), re: ref.messageId });
      return { address: ref.address, messageId: `out${sent.length}` };
    },
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
  const reg = new ConversationRegistry(config(opts.agent ?? 'cc'), new Map([['discord', platform]]), factory, clock);

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
  return {
    send,
    prompts,
    asked,
    aborts: () => aborts,
    release: async () => {
      release();
      await drain();
    },
    /** Let the stub's side question be stopped, resolving it as `stopped`. */
    stoppable: (resolve: () => void) => void (stopSide = resolve),
    sent,
    /** The id the next `send` gives its message. */
    nextId: () => `m${n + 1}`,
    asides: () => sent.filter((m) => m.kind === 'aside').map((m) => m.text),
    replies: () => sent.filter((m) => !m.kind && !m.text.startsWith('🤖')).map((m) => m.text),
  };
}

describe('/btw while a turn runs', () => {
  it('is answered at once in a message of its own, and the turn is neither stopped nor sent the question', async () => {
    const r = rig();
    await r.send('run the full suite');
    await r.send('/btw which branch are we on?');

    expect(r.asked).toEqual(['which branch are we on?']);
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toEqual(['run the full suite']);
    expect(r.asides()).toEqual([
      '↪ btw: which branch are we on?\n\nmain is on feat/x\n\nside question — not kept in this conversation',
    ]);

    await r.release();
    // Nothing was queued behind the turn either.
    expect(r.prompts).toEqual(['run the full suite']);
  });

  it('says how many tools the answer ran, and that it was stopped', async () => {
    const r = rig({
      side: (h) =>
        new Promise((resolve) => {
          h.onToolStart({ id: 't1', name: 'read', preview: 'a.ts' } as never);
          h.onSegmentBreak();
          h.onText('it is feat/x');
          r.stoppable(() => resolve('stopped'));
        }),
    });
    await r.send('hello');
    await r.send('/btw which branch?');
    await r.send('/stop');

    expect(r.asides()).toEqual([
      '↪ btw: which branch?\n\nit is feat/x\n\nside question — not kept in this conversation · 1 tool call · stopped',
    ]);
    expect(r.replies().at(-1)).toMatch(/^⏹ Stopped\. .*\n⏹ Also stopped the side question\.$/s);
  });

  it('is what /stop stops when no turn is running', async () => {
    const r = rig({ side: () => new Promise((resolve) => r.stoppable(() => resolve('stopped'))) });
    await r.send('hello');
    await r.release();
    await r.send('/btw anything?');
    await r.send('/stop');
    expect(r.replies().at(-1)).toBe('⏹ Stopped the side question.');
    // Stopped before a word of it came: the question and the closing line, nothing in between.
    expect(r.asides()).toEqual(['↪ btw: anything?\n\nside question — not kept in this conversation · stopped']);
  });
});

describe('/btw refused', () => {
  it("sends the runtime's refusal as it stands, and opens no answer", async () => {
    const r = rig({
      side: async () => {
        throw new SideQuestionRefused('mine does not support /btw: its agent declares no session/fork, which a side question is asked on.');
      },
      agent: 'mine',
    });
    await r.send('/btw q');
    expect(r.asked).toEqual(['q']); // a custom agent is asked — whether it can fork is its own to say
    // The sentence alone, with no `↪ btw:` header over it: that would be an answer that never came.
    // Marked aside like an answer, because it is the reply to the /btw and not the conversation's.
    expect(r.asides()).toEqual(['mine does not support /btw: its agent declares no session/fork, which a side question is asked on.']);
    expect(r.replies()).toEqual([]);
    expect(r.prompts).toEqual([]); // and it was never forwarded as a prompt
  });

  it('is refused by name on a harness known not to fork, without asking the runtime', async () => {
    const r = rig({ agent: 'ag' });
    await r.send('/btw q');
    expect(r.asked).toEqual([]);
    expect(r.asides()).toEqual(['agy does not support /btw.']);
    expect(r.prompts).toEqual([]);
  });

  it('says how to use it when there is no question', async () => {
    const r = rig();
    await r.send('/btw');
    expect(r.asides().at(-1)).toMatch(/^Usage: `\/btw <question>`/);
    expect(r.asked).toEqual([]);
  });

  it('reports a failure in the answer itself', async () => {
    const r = rig({
      side: async (h) => {
        h.onText('half an');
        throw new Error('ACP connection closed');
      },
    });
    await r.send('/btw q');
    expect(r.asides()).toEqual(['↪ btw: q\n\nhalf an\n\nside question — not kept in this conversation · failed: ACP connection closed']);
  });

  it('says so for a runtime with no side questions at all', async () => {
    const r = rig({ noSide: true });
    await r.send('/btw q');
    expect(r.asides()).toEqual(['claude does not support /btw.']);
  });
});

describe('/btw on a platform with replies', () => {
  it('answers as a reply to the /btw, so it hangs off the question rather than following the conversation', async () => {
    const r = rig({
      reply: 'ok',
      side: async (h) => {
        h.onNotice?.('⚠ retrying after an API error');
        h.onText('it is feat/x');
        return 'done';
      },
    });
    await r.send('run the full suite');
    const question = r.nextId();
    await r.send('/btw which branch?');

    // The answer and the notice about it both name the /btw they belong to; nothing of the side
    // question went out as a plain message.
    expect(r.sent.filter((m) => m.kind === 'aside')).toEqual([
      { text: '⚠ retrying after an API error', kind: 'aside', re: question },
      { text: '↪ btw: which branch?\n\nit is feat/x\n\nside question — not kept in this conversation', kind: 'aside', re: question },
    ]);
    expect(r.sent.filter((m) => m.re === undefined && m.kind === 'aside')).toEqual([]);
  });

  it('replies with a refusal too', async () => {
    const r = rig({ reply: 'ok', agent: 'ag' });
    const question = r.nextId();
    await r.send('/btw q');
    expect(r.sent).toEqual([{ text: 'agy does not support /btw.', kind: 'aside', re: question }]);
  });

  it('falls back to a plain send when the reply is refused, and the answer still arrives', async () => {
    // A native slash command's "message" is an interaction nothing can quote.
    const r = rig({ reply: 'refused' });
    await r.send('/btw which branch?');
    expect(r.sent).toEqual([
      { text: '↪ btw: which branch?\n\nmain is on feat/x\n\nside question — not kept in this conversation', kind: 'aside' },
    ]);
  });
});
