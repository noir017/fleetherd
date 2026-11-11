import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ButtonInteraction, InboundMessage, MessageRef } from '../types.js';
import type { AgentFactory, AgentSession } from './agent.js';
import { Daemon } from './daemon.js';

/**
 * The voice path through the REAL inbound path — Daemon.onInbound → ConversationRegistry.route →
 * the voice hook → a tap → route() again → the merger → the agent's prompt.
 *
 * voice.test.ts pins what the card does; this pins where it sits. The failures it guards are all
 * about placement, and none of them announces itself: a voice note that reached the merger would
 * interrupt the running turn before anyone approved the words; a confirmed transcript that was
 * offered for transcription again would loop; a transcript that superseded its sibling would
 * silently drop the user's second voice note; and an agent prompt that mentioned audio would break
 * the "the agent does not know it was spoken" contract.
 */

const CONV = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
const OGG_B64 = Buffer.from('OggS\x00\x02 pretend opus', 'binary').toString('base64');

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

/**
 * Wait for something the voice path produces, rather than for a fixed time. A voice note is
 * several real hops (a data: URL decoded, a file written, the transcriber stub, the card), and
 * two of them are serialized by design — a fixed 80 ms was enough here and not on a CI runner,
 * where the second card had not been posted yet (v1.34.0's release build).
 */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never happened: ${what}`);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aa-voice-route-'));
  // The transcript log is written under configDir(); never let a test reach the operator's real one.
  vi.stubEnv('FLEETHERD_CONFIG_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function rig(opts: { voice?: boolean } = {}) {
  const transcripts = ['帮我看下 CI 为什么挂了', '第二句'];
  const answer = (text: string): Response =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
  // Cleanup is on by default, so each voice note is two requests: the audio, then its transcript as
  // text. The second is answered with the transcript itself — "nothing to clean up" — which keeps
  // this file about routing while still going through the cleanup's request and its parse.
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const frame = /^<transcript>\n([\s\S]*)\n<\/transcript>$/.exec(
      (JSON.parse(init.body) as { contents: Array<{ parts: Array<{ text?: string }> }> }).contents[0]?.parts[0]?.text ?? ''
    );
    return answer(frame ? frame[1]! : (transcripts.shift() ?? '…'));
  });
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    ...(opts.voice === false
      ? {}
      : { voice: { transcriber: { baseUrl: 'http://gw/v1beta', apiKey: 'k', model: 'gemini-3-flash' } } }),
  });
  const cfg = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
    attachments: { ...parsed.attachments, cacheDir: path.join(dir, 'attachments') },
  };

  const prompts: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input: { prompt: string }) => void prompts.push(input.prompt),
          abort: () => {},
          dispose: () => {},
        } as unknown as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const sent: string[] = [];
  const cards: Array<{ text: string; buttons: Array<{ id: string }> }> = [];
  const edits: string[] = [];
  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: {
      thread: true, editMessage: true, editButtons: true, buttons: true,
      reaction: true, reply: true, slashCommands: true, typing: true, maxMessageLength: 4096,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (address: { channel: string }, text: string, buttons: Array<{ id: string }>) => {
      cards.push({ text, buttons });
      return { address, messageId: `card${cards.length}` };
    },
    editButtons: async (_ref: MessageRef, text: string) => void edits.push(text),
    editMessage: async (_ref: MessageRef, text: string) => void edits.push(text),
    addReaction: async () => {},
    removeReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, path.join(dir, 'd.sock'));
  const d = daemon as unknown as { onInbound(m: InboundMessage): void; onButton(ev: ButtonInteraction): void };
  let n = 0;
  const voice = async (): Promise<void> => {
    d.onInbound({
      conversation: CONV,
      messageId: `in${++n}`,
      content: '',
      timestamp: Date.now(),
      attachments: [{ type: 'audio', url: `data:audio/opus;base64,${OGG_B64}` }],
    });
    await drain();
  };
  const type = async (content: string): Promise<void> => {
    d.onInbound({ conversation: CONV, messageId: `in${++n}`, content, timestamp: Date.now() });
    await drain();
  };
  const tap = async (card: number, button: 0 | 1): Promise<void> => {
    d.onButton({ conversation: CONV, messageId: 'cb', buttonId: cards[card]!.buttons[button]!.id });
    await drain();
  };
  return { voice, type, tap, prompts, sent, cards, edits };
}

describe('a voice message through the real inbound path', () => {
  it('reaches the agent only after Send, as exactly the words — nothing about audio', async () => {
    const r = rig();
    await r.voice();
    await until('the card is posted', () => r.cards.length === 1);
    expect(r.prompts).toEqual([]); // no turn ran on the unconfirmed recording
    await r.tap(0, 0);
    await until('the turn runs', () => r.prompts.length === 1);
    expect(r.prompts).toEqual(['帮我看下 CI 为什么挂了']);
  });

  it('confirming one of two voice notes does not drop the other', async () => {
    const r = rig();
    await r.voice();
    await r.voice();
    await until('both cards are posted', () => r.cards.length === 2);
    await r.tap(0, 0);
    await until('the first turn runs', () => r.prompts.length === 1);
    await r.tap(1, 0);
    await until('the second turn runs', () => r.prompts.length === 2);
    expect(r.prompts.join('\n')).toContain('第二句');
  });

  it('typing instead replaces the waiting transcript: only the typed words reach the agent', async () => {
    const r = rig();
    await r.voice();
    await until('the card is posted', () => r.cards.length === 1);
    await r.type('帮我看下 CD 为什么挂了');
    await until('the typed turn runs', () => r.prompts.length === 1);
    expect(r.prompts).toEqual(['帮我看下 CD 为什么挂了']);
    expect(r.edits.at(-1)).toMatch(/Replaced by the message you typed/);
    await r.tap(0, 0);
    expect(r.prompts).toHaveLength(1);
  });

  it('/stop calls the transcript off and says that is what it stopped', async () => {
    const r = rig();
    await r.voice();
    await until('the card is posted', () => r.cards.length === 1);
    await r.type('/stop');
    await until('/stop answers', () => r.sent.some((t) => /Called off the voice transcript/.test(t)));
    expect(r.sent.at(-1)).toMatch(/Called off the voice transcript/);
    expect(r.edits.at(-1)).toMatch(/Called off \(stopped\)/);
    expect(r.prompts).toEqual([]);
  });

  it('without a voice: block, a voice note is an attachment as before — and no base64 in the prompt', async () => {
    const r = rig({ voice: false });
    await r.voice();
    await until('the turn runs', () => r.prompts.length === 1);
    expect(r.cards).toEqual([]);
    expect(r.prompts[0]).toMatch(/Attachments:\n\[Attachment file\.opus: /);
    expect(r.prompts[0]).not.toContain(OGG_B64);
  });
});
