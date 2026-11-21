import { afterEach, describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';

const daemons: Daemon[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
});
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type {
  AgentElicitation,
  ButtonInteraction,
  ElicitAnswer,
  InboundMessage,
  MessageRef,
} from '../types.js';

/**
 * Answering the agent's question by TYPING instead of tapping.
 *
 * The bug this file pins down: a typed reply used to reach the inbound merger, whose job was then to
 * interrupt the running turn — and the running turn is the one blocked on the question. So on a
 * multi-question form, answering question 2 in words (because none of its options fit, which is the
 * only reason anyone types) killed the agent mid-form: questions 1 and 2 were answered for nothing
 * and question 3 was never asked. The reply then ran as a fresh instruction with none of the
 * context that made it an answer.
 *
 * The answer travels back under the question's own free-text field (`question_<n>_custom`), which
 * claude-agent-acp declares next to every question and gives precedence over the enum — so nothing
 * here fabricates an option the agent never offered.
 */

const parsed = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' } },
  agents: [{ id: 'cc', harness: 'claude' }],
  routing: { default: 'cc' },
});
// Shrink the merge window so a dispatched message reaches the agent promptly. Applied post-parse:
// `inbound` is part of the frozen EXPERIENCE block and would be discarded from the input.
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };

/** A two-question form shaped exactly like claude's:每题都带一个 `_custom` 自由文本框。 */
const TWO_QUESTIONS: AgentElicitation = {
  message: 'Please answer the following questions.',
  questions: [
    {
      key: 'question_0',
      prompt: '用哪个数据库？',
      options: [
        { label: 'PostgreSQL', value: 'PostgreSQL', description: '你已经在跑 pgvector。' },
        { label: 'MySQL', value: 'MySQL' },
      ],
      customKey: 'question_0_custom',
      multi: false,
    },
    {
      key: 'question_1',
      prompt: '部署到哪里？',
      options: [{ label: 'Fly.io', value: 'Fly.io' }],
      customKey: 'question_1_custom',
      multi: false,
    },
  ],
};

function rig(caps: { editButtons?: boolean } = {}) {
  const prompts: string[] = [];
  const sent: string[] = [];
  const edits: Array<{ messageId: string; text: string }> = [];
  const buttonEdits: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const answers: ElicitAnswer[] = [];
  const sessions = new Map<string, AgentSession>();
  let aborts = 0;
  /** The form the next turn asks, if any. Consumed once, so a follow-up turn asks nothing. */
  let pendingForm: AgentElicitation | undefined;
  /** Held open to keep one question's send in flight — that is the window a race lives in. */
  let gate: Promise<void> | undefined;

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input: { prompt: string }, handlers: AgentStreamHandlers) => {
            prompts.push(input.prompt);
            const form = pendingForm;
            pendingForm = undefined;
            if (form) answers.push(await handlers.onElicit!(form));
          },
          abort: () => void aborts++,
          dispose: () => {},
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
      thread: true, editMessage: true, editButtons: caps.editButtons ?? true, buttons: true,
      reaction: true, reply: true, slashCommands: true, typing: true, maxMessageLength: 4096,
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
      if (gate) {
        const held = gate;
        gate = undefined;
        await held;
      }
      buttonSends.push({ text, buttons });
      return { address, messageId: `ask-msg-${buttonSends.length}` };
    },
    editButtons: async (
      _ref: MessageRef,
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonEdits.push({ text, buttons });
    },
    editMessage: async (ref: MessageRef, text: string) => {
      edits.push({ messageId: ref.messageId, text });
    },
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    stop: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, '/tmp/aa-elicit-test.sock');
  daemons.push(daemon);
  const d = daemon as unknown as {
    onInbound(m: InboundMessage): void;
    onButton(ev: ButtonInteraction): void;
  };

  let n = 0;
  const send = async (content: string, attachments?: InboundMessage['attachments']): Promise<void> => {
    d.onInbound({
      conversation: CONVERSATION,
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
      ...(attachments ? { attachments } : {}),
    });
    await drain();
  };
  const click = async (buttonId: string): Promise<void> => {
    d.onButton({ conversation: CONVERSATION, messageId: 'callback-query-id', buttonId });
    await drain();
  };
  /** The id of the nth posted question's first button (`ask:<reqId>:0`). */
  const firstButtonOf = (round: number): string => buttonSends[round]!.buttons[0]!.id;
  /** The id of one of the nth posted question's buttons, by position (Done is one past the options). */
  const buttonOf = (round: number, index: number): string =>
    buttonSends[round]!.buttons[index]!.id;
  const ask = (form: AgentElicitation): void => void (pendingForm = form);
  /** Keep the next question's send in flight until the returned function is called. */
  const holdNextButtonSend = (): (() => Promise<void>) => {
    let release = (): void => {};
    gate = new Promise<void>((r) => void (release = r));
    return async () => {
      release();
      await drain();
    };
  };

  return {
    ask, send, click, firstButtonOf, buttonOf, holdNextButtonSend,
    prompts, sent, edits, buttonEdits, buttonSends, answers, aborts: () => aborts,
  };
}

describe('a typed reply answers the question instead of interrupting the turn', () => {
  it('carries the words back under the question’s own free-text field, and keeps asking', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');
    expect(r.buttonSends).toHaveLength(1); // question 1 is up

    await r.send('都不合适，用 SQLite'); // none of the options fit — so type
    expect(r.buttonSends).toHaveLength(2); // …and question 2 is asked, which is the whole point

    await r.click(r.firstButtonOf(1));
    expect(r.answers).toEqual([
      {
        action: 'accept',
        content: {
          // The typed answer under the custom key — NOT `question_0`, which would mean claiming the
          // user picked an option the agent listed. The harness prefers the custom field anyway.
          question_0_custom: '都不合适，用 SQLite',
          question_1: 'Fly.io',
        },
      },
    ]);
    // The turn was never interrupted and the reply never ran as an instruction of its own.
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toEqual(['帮我搭个后端']);
  });

  it('retires the question bubble: buttons cleared, the answer recorded on it', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');
    await r.send('都不合适，用 SQLite');

    // editButtons with an EMPTY array, not a text-only editMessage: only Discord and Telegram drop
    // components on a plain edit, so on Slack/Lark the answered question stayed clickable.
    expect(r.buttonEdits[0]!.buttons).toEqual([]);
    expect(r.buttonEdits[0]!.text).toContain('用哪个数据库？');
    expect(r.buttonEdits[0]!.text).toContain('→ Answered: 都不合适，用 SQLite');
  });

  it('a tapped option still answers with the option’s value, and clears its buttons too', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');
    await r.click(r.firstButtonOf(0));
    await r.click(r.firstButtonOf(1));

    expect(r.answers[0]).toEqual({
      action: 'accept',
      content: { question_0: 'PostgreSQL', question_1: 'Fly.io' },
    });
    expect(r.buttonEdits[0]).toEqual({
      text: '(1/2) 用哪个数据库？\n\n**PostgreSQL** — 你已经在跑 pgvector。\n\n→ Selected: PostgreSQL',
      buttons: [],
    });
  });

  it('a question with no free-text field is not answered by typing — the words wait, /stop is the way out', async () => {
    const r = rig();
    // An MCP server's own elicitation: enum options, no "Other" box. Sending the typed words as the
    // enum value would hand the server something it never offered (see ElicitOption).
    r.ask({
      message: '选一个',
      questions: [
        { key: 'choice', prompt: '选一个', options: [{ label: 'A', value: 'a' }], multi: false },
      ],
    });
    await r.send('帮我搭个后端');
    await r.send('都不合适');

    // An ordinary mid-turn message now: it no longer cancels the turn (which used to be the way out
    // of a question like this), so the question stays on screen and the words wait behind the turn.
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toEqual(['帮我搭个后端']);
    expect(r.answers).toEqual([]);

    await r.send('/stop');
    expect(r.aborts()).toBe(1);
    expect(r.answers).toEqual([{ action: 'cancel' }]);
  });

  it('an attachment is not an answer — the image would be silently dropped', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');
    await r.send('照这个来', [{ url: 'https://example.com/a.png', name: 'a.png', type: 'image' }]);

    // A new message carrying a file, not an answer: the wire field a typed answer travels in takes a
    // string. It goes where any mid-turn message goes — and, like any, it cancels nothing, so the
    // question is still waiting for its answer.
    expect(r.aborts()).toBe(0);
    expect(r.answers).toEqual([]);
    expect(r.buttonEdits.some((e) => e.text.includes('Answered'))).toBe(false);
  });
});

describe('the window between two rounds, where nothing is on screen yet', () => {
  it('an answer typed while the next question is still being posted reaches it anyway', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');

    const release = r.holdNextButtonSend();
    await r.click(r.firstButtonOf(0)); // question 1 answered → question 2 is now mid-send
    await r.send('随便，你定'); // arrives in the gap: nothing is pending

    // The message that would have killed the form did not. It is parked for the question in flight.
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toEqual(['帮我搭个后端']);

    await release();
    expect(r.answers).toEqual([
      { action: 'accept', content: { question_0: 'PostgreSQL', question_1_custom: '随便，你定' } },
    ]);
    expect(r.buttonEdits.at(-1)!.text).toContain('→ Answered: 随便，你定');
  });

  it('a /stop in the same window still calls the question off', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');

    const release = r.holdNextButtonSend();
    await r.click(r.firstButtonOf(0));
    await r.send('/stop'); // nothing on screen to cancel — the next question is mid-send

    await release();
    expect(r.answers).toEqual([{ action: 'cancel' }]);
    // Retired the moment it appeared, rather than sitting there clickable for ten minutes.
    expect(r.buttonEdits.at(-1)).toEqual({ text: '(2/2) 部署到哪里？\n\n(stopped)', buttons: [] });
  });
});

describe('calling a question off', () => {
  it('/stop retires the bubble and frees the next message from being read as an answer', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');
    await r.send('/stop');

    expect(r.answers).toEqual([{ action: 'cancel' }]);
    expect(r.buttonEdits.at(-1)).toEqual({
      text: '(1/2) 用哪个数据库？\n\n**PostgreSQL** — 你已经在跑 pgvector。\n\n(stopped)',
      buttons: [],
    });

    // The next message is an instruction again, not an answer to a question nobody is waiting on.
    await r.send('换个话题');
    expect(r.prompts).toEqual(['帮我搭个后端', '换个话题']);
  });

  it('/new does the same, since the context the question belongs to is being discarded', async () => {
    const r = rig();
    r.ask(TWO_QUESTIONS);
    await r.send('帮我搭个后端');
    await r.send('/new');

    expect(r.answers).toEqual([{ action: 'cancel' }]);
    expect(r.buttonEdits.at(-1)!.text).toContain('(context cleared)');
  });
});

/**
 * A question the agent asked with `multiSelect: true` — `type: 'array'` on the wire, and an answer
 * the harness comma-joins (claude-agent-acp's applyAskElicitationResponse). It used to be collected
 * with the ordinary one-tap question and sent back as a single-element array, so "pick every one
 * that applies" could only ever be answered with one.
 */
const MULTI_FORM: AgentElicitation = {
  message: '哪些区域要部署？',
  questions: [
    {
      key: 'question_0',
      prompt: '哪些区域要部署？',
      options: [
        { label: 'EU', value: 'eu', description: '离你的用户最近。' },
        { label: 'US', value: 'us' },
        { label: 'APAC', value: 'ap' },
      ],
      customKey: 'question_0_custom',
      multi: true,
    },
  ],
};

describe('a question that takes more than one answer', () => {
  it('taps toggle and Done answers with every option that was ticked', async () => {
    const r = rig();
    r.ask(MULTI_FORM);
    await r.send('帮我上线');

    // Posted with a checkbox per option and a Done button one index past them.
    expect(r.buttonSends[0]!.buttons.map((b) => b.label)).toEqual(['☐ EU', '☐ US', '☐ APAC', '✅ Done']);
    expect(r.buttonSends[0]!.text).toContain('Tap to select as many as apply');

    await r.click(r.buttonOf(0, 2)); // APAC on
    await r.click(r.buttonOf(0, 0)); // EU on
    await r.click(r.buttonOf(0, 2)); // APAC off again — a tap is a toggle, not a commit
    expect(r.buttonEdits.at(-1)!.buttons.map((b) => b.label)).toEqual([
      '☑ EU', '☐ US', '☐ APAC', '✅ Done (1)',
    ]);
    expect(r.answers).toHaveLength(0); // still open: only Done answers

    await r.click(r.buttonOf(0, 1)); // US on
    await r.click(r.buttonOf(0, 3)); // Done

    // An array under the question's own key, carrying the options' `value`s in the order the agent
    // listed them — not the order they happened to be tapped in.
    expect(r.answers).toEqual([{ action: 'accept', content: { question_0: ['eu', 'us'] } }]);
    expect(r.buttonEdits.at(-1)).toEqual({
      text: '哪些区域要部署？\n\n**EU** — 离你的用户最近。\n\n→ Selected: EU, US',
      buttons: [],
    });
  });

  it('Done with nothing ticked says so instead of answering, or doing nothing at all', async () => {
    const r = rig();
    r.ask(MULTI_FORM);
    await r.send('帮我上线');
    await r.click(r.buttonOf(0, 3));

    expect(r.answers).toHaveLength(0); // an empty array is not an answer the agent asked for
    expect(r.buttonEdits.at(-1)!.text).toContain('Nothing selected yet');
    expect(r.buttonEdits.at(-1)!.buttons).toHaveLength(4); // and the question is still up
  });

  it('a typed answer still wins, and still travels under the free-text field', async () => {
    const r = rig();
    r.ask(MULTI_FORM);
    await r.send('帮我上线');
    await r.click(r.buttonOf(0, 0)); // a tick the words then override
    await r.send('EU 和 US，另外加 sa-east-1');

    expect(r.answers).toEqual([
      { action: 'accept', content: { question_0_custom: 'EU 和 US，另外加 sa-east-1' } },
    ]);
  });

  it('where the buttons cannot be repainted, the round degrades to one tap and says so', async () => {
    // LINE and QQ: buttons yes, editButtons no. The tick lives in the button label, so a
    // multi-select there would be one the user can never see move.
    const r = rig({ editButtons: false });
    r.ask(MULTI_FORM);
    await r.send('帮我上线');

    expect(r.buttonSends[0]!.buttons.map((b) => b.label)).toEqual(['EU', 'US', 'APAC']);
    expect(r.buttonSends[0]!.text).toContain('takes more than one answer');
    await r.click(r.buttonOf(0, 0));

    // Still an array, because the field is still `type: 'array'` — just one entry in it.
    expect(r.answers).toEqual([{ action: 'accept', content: { question_0: ['eu'] } }]);
  });
});
