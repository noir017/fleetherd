import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { ButtonSpec, PlatformAdapter } from '../platform/adapter.js';
import { asUndelivered, TurnFailure, type AgentFactory, type AgentSession, type AgentStreamHandlers, type RunTurnInput } from './agent.js';
import type { InboundMessage } from '../types.js';
import { parseRetryButtonId } from '../core/turn-retry.js';

/**
 * A failed turn's input, end to end through the registry and the turn runner: held for the next
 * turn when the agent never received it, sent again from the ❌ notice's Retry buttons, and never
 * sent twice (failed-input.ts, core/turn-retry.ts).
 */

const START_FAILED = 'agent "cc" started, but session/new got no answer within 30s.';

function inbound(content: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    conversation: { platform: 'web', channel: 'main', thread: 't1', kind: 'direct', user: 'u1' },
    messageId: `m-${content}`,
    content,
    timestamp: 0,
    ...extra,
  };
}

/** Let the 1 ms merge window elapse, the turn run and end, and the render chain drain. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function rig(opts: { buttons: boolean; agents?: string[] }) {
  const parsed = parseConfig({
    platforms: { web: { type: 'webui', token: 't' } },
    agents: (opts.agents ?? ['cc']).map((id) => ({ id, harness: 'claude' })),
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  const sent: string[] = [];
  const buttons: Array<{ text: string; buttons: ButtonSpec[]; id: string }> = [];
  const edits: Array<{ id: string; text: string; buttons: ButtonSpec[] }> = [];
  let seq = 0;
  const platform = {
    capabilities: { thread: true, editMessage: true, buttons: opts.buttons, editButtons: opts.buttons, maxMessageLength: 4000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${++seq}` };
    },
    sendButtons: async (address: { channel: string }, text: string, b: ButtonSpec[]) => {
      const id = `b${++seq}`;
      buttons.push({ text, buttons: b, id });
      return { address, messageId: id };
    },
    editButtons: async (ref: { messageId: string }, text: string, b: ButtonSpec[]) => {
      edits.push({ id: ref.messageId, text, buttons: b });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  /** Each prompt that reached an agent, with which agent. */
  const prompts: Array<{ agent: string; prompt: string }> = [];
  /** How the next turns go: 'undelivered' fails before the prompt is sent; 'ok' answers. */
  const script: Array<'undelivered' | 'delivered' | 'ok'> = [];
  const factory: AgentFactory = {
    getOrCreate(conversationId, agentId): AgentSession {
      return {
        conversationId,
        runTurn: async (input: RunTurnInput, h: AgentStreamHandlers) => {
          const step = script.shift() ?? 'ok';
          if (step === 'undelivered') throw asUndelivered(new TurnFailure(START_FAILED, 'startup'));
          prompts.push({ agent: agentId, prompt: input.prompt });
          if (step === 'delivered') throw new TurnFailure('upstream busy', 'service');
          h.onText('done');
        },
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
      } as unknown as AgentSession;
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['web', platform]]), factory, clock);
  const retryIdOf = (i = buttons.length - 1): string => parseRetryButtonId(buttons[i]!.buttons[0]!.id)!.retryId;
  return { reg, sent, buttons, edits, prompts, script, retryIdOf };
}

describe('a turn the agent never received', () => {
  it('says so, and sends it along with the next message', async () => {
    const r = rig({ buttons: false });
    r.script.push('undelivered');
    r.reg.route(inbound('build the release'));
    await drain();
    expect(r.prompts).toEqual([]);
    expect(r.sent).toContain(
      `❌ This turn failed: ${START_FAILED}\nThe agent did not receive this — it will be sent along with the next message.`
    );
    r.reg.route(inbound('继续'));
    await drain();
    expect(r.prompts).toEqual([{ agent: 'cc', prompt: 'build the release\n继续' }]);
    // Once: the turn after that carries only its own.
    r.reg.route(inbound('thanks'));
    await drain();
    expect(r.prompts.at(-1)).toEqual({ agent: 'cc', prompt: 'thanks' });
  });

  it('keeps the attachments of what it holds', async () => {
    const r = rig({ buttons: false });
    r.script.push('undelivered');
    r.reg.route(inbound('read this', { attachments: [{ type: 'file', url: 'data:text/plain;base64,aGVsbG8=', name: 'n.txt', mime: 'text/plain' }] }));
    await drain();
    r.reg.route(inbound('go'));
    await drain();
    expect(r.prompts[0]!.prompt).toContain('read this\ngo');
    expect(r.prompts[0]!.prompt).toContain('n.txt');
  });
});

describe('the ❌ notice’s Retry buttons', () => {
  it('Retry sends the failed turn again, once, and takes the buttons off', async () => {
    const r = rig({ buttons: true });
    r.script.push('undelivered');
    r.reg.route(inbound('build the release'));
    await drain();
    expect(r.buttons).toHaveLength(1);
    expect(r.buttons[0]!.buttons.map((b) => b.label)).toEqual(['Retry']); // one agent: nobody else to pick
    const answer = await r.reg.retryTurn({ retryId: r.retryIdOf(), user: 'u1' });
    expect(answer).toEqual({ done: true, text: '↻ Retrying with cc.' });
    await drain();
    expect(r.prompts).toEqual([{ agent: 'cc', prompt: 'build the release' }]);
    expect(r.edits).toEqual([{ id: r.buttons[0]!.id, text: r.buttons[0]!.text, buttons: [] }]);
    // The hold went with it: the next message is not sent with the task a second time.
    r.reg.route(inbound('and the notes'));
    await drain();
    expect(r.prompts.at(-1)).toEqual({ agent: 'cc', prompt: 'and the notes' });
    // A second tap finds nothing.
    expect((await r.reg.retryTurn({ retryId: r.retryIdOf(0), user: 'u1' })).done).toBe(false);
  });

  it('after the held message went out with the next one, Retry has nothing left to send', async () => {
    const r = rig({ buttons: true });
    r.script.push('undelivered');
    r.reg.route(inbound('build the release'));
    await drain();
    r.reg.route(inbound('继续'));
    await drain();
    expect(r.prompts).toEqual([{ agent: 'cc', prompt: 'build the release\n继续' }]);
    const answer = await r.reg.retryTurn({ retryId: r.retryIdOf(0), user: 'u1' });
    expect(answer.done).toBe(false);
    await drain();
    expect(r.prompts).toHaveLength(1);
  });

  it('retries a delivered failure too — the whole input, as the person', async () => {
    const r = rig({ buttons: true });
    r.script.push('delivered');
    r.reg.route(inbound('summarise the incident'));
    await drain();
    expect(r.sent.some((t) => t.includes('did not receive'))).toBe(false);
    await r.reg.retryTurn({ retryId: r.retryIdOf(), user: 'u1' });
    await drain();
    expect(r.prompts.map((p) => p.prompt)).toEqual(['summarise the incident', 'summarise the incident']);
  });

  it('Retry with another agent moves a topic that has no session yet, and sends it there', async () => {
    const r = rig({ buttons: true, agents: ['cc', 'ag'] });
    r.script.push('undelivered');
    r.reg.route(inbound('build the release'));
    await drain();
    expect(r.buttons[0]!.buttons.map((b) => b.label)).toEqual(['Retry', 'Retry with another agent']);
    const answer = await r.reg.retryTurn({ retryId: r.retryIdOf(), user: 'u1', agentId: 'ag' });
    expect(answer).toEqual({ done: true, text: '↻ Retrying with ag — it answers this topic now.' });
    await drain();
    expect(r.prompts).toEqual([{ agent: 'ag', prompt: 'build the release' }]);
  });
});
