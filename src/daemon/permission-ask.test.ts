import { afterEach, describe, expect, it, vi } from 'vitest';
import { composePermissionPrompt, Daemon } from './daemon.js';
import { parseConfig } from '../config/schema.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { AgentPermissionRequest, ButtonInteraction, InboundMessage, PermissionAnswer } from '../types.js';

/**
 * `permissions: ask` on the chat side: what the user is shown, and what each way of answering — or
 * not answering — becomes. The ACP half (how a PermissionAnswer reaches the agent) is in
 * agent-acp-permission.test.ts; this file stops at the PermissionAnswer the runtime receives.
 */

const parsed = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' } },
  agents: [{ id: 'cc', harness: 'claude', permissions: 'ask' }],
  routing: { default: 'cc' },
});
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };

/** As claude-agent-acp 0.81.2 offers it for a shell command (measured 2026-10-28). */
const TOUCH: AgentPermissionRequest = {
  title: 'touch probe-file.txt',
  options: [
    { optionId: 'allow-once', label: 'Allow' },
    { optionId: 'reject', label: 'Reject' },
  ],
};

/** An edit, as claude-agent-acp sends one: the change rides along with the title. */
const EDIT: AgentPermissionRequest = {
  title: 'Edit src/app.ts',
  detail: '--- /w/src/app.ts\n+++ /w/src/app.ts\n-const PORT = 3000;\n+const PORT = 8080;',
  options: [
    { optionId: 'allow-once', label: 'Allow' },
    { optionId: 'reject', label: 'Reject' },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

function rig(caps: { buttons?: boolean } = {}, request: AgentPermissionRequest = TOUCH) {
  const sent: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const buttonEdits: Array<{ text: string }> = [];
  const answers: PermissionAnswer[] = [];
  const sessions = new Map<string, AgentSession>();

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          // Every turn asks once, the way claude does before a file-writing Bash call.
          runTurn: async (_input: unknown, handlers: AgentStreamHandlers) => {
            answers.push(await handlers.onPermission!(request));
          },
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

  const platform = {
    platform: 'tg',
    platformType: caps.buttons === false ? 'wecom' : 'telegram',
    capabilities: {
      thread: true, editMessage: true, editButtons: true, buttons: caps.buttons ?? true,
      reaction: true, reply: true, slashCommands: true, typing: true, maxMessageLength: 4096,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (address: { channel: string }, text: string, buttons: Array<{ id: string; label: string }>) => {
      buttonSends.push({ text, buttons });
      return { address, messageId: `ask-msg-${buttonSends.length}` };
    },
    editButtons: async (_ref: unknown, text: string) => void buttonEdits.push({ text }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, '/tmp/aa-permission-test.sock');
  const d = daemon as unknown as {
    onInbound(m: InboundMessage): void;
    onButton(ev: ButtonInteraction): void;
    registry: {
      runScheduledPrompt(o: { key: string; platform: string; address: { channel: string }; agentId: string; prompt: string }): Promise<unknown>;
    };
  };
  let n = 0;
  const send = async (content: string): Promise<void> => {
    d.onInbound({ conversation: CONVERSATION, messageId: `in${++n}`, content, timestamp: Date.now(), mentionedSelf: true });
    await new Promise((r) => setTimeout(r, 30));
  };
  const click = async (label: string): Promise<void> => {
    const id = buttonSends.at(-1)!.buttons.find((b) => b.label === label)!.id;
    d.onButton({ conversation: CONVERSATION, messageId: 'cb', buttonId: id });
    await new Promise((r) => setTimeout(r, 30));
  };
  return { send, click, sent, buttonSends, buttonEdits, answers, daemon: d };
}

describe('the bubble a permission request is posted as', () => {
  it('shows the change under the title when the request carries one', () => {
    const text = composePermissionPrompt('Edit src/app.ts', DEFAULT_ASK_TIMEOUT_MS, '-const PORT = 3000;\n+const PORT = 8080;');
    expect(text).toContain('Edit src/app.ts');
    expect(text).toContain('-const PORT = 3000;\n+const PORT = 8080;');
    expect(text).toContain('No answer within 60 min declines it.');
  });

  it('cannot let a title that carries a fence end its own block either', () => {
    // `_meta` tool names reach the title without going through stripCode, so the title needs the
    // same neutralisation the detail gets.
    const text = composePermissionPrompt('Wr\nite```: /path', DEFAULT_ASK_TIMEOUT_MS);
    expect(text.match(/^```$/gm)).toHaveLength(2);
    expect(text).toContain('Wr\nite``: /path');
  });

  it('cannot let the file’s own fence split the bubble in two', () => {
    // A Write of a markdown file is the everyday case: three backticks in the content would end
    // the block early on every platform that reads a fence line by line.
    const text = composePermissionPrompt('Write notes.md', DEFAULT_ASK_TIMEOUT_MS, '```ts\nx\n```');
    expect(text.match(/^```$/gm)).toHaveLength(4); // the title's pair and the detail's pair
    expect(text).toContain('``ts');
  });
});

describe('a permission request in the chat', () => {
  it('shows what the agent wants to run, with its own options as the buttons', async () => {
    const r = rig();
    await r.send('make the file');
    const bubble = r.buttonSends.at(-1)!;
    expect(bubble.text).toContain('touch probe-file.txt');
    expect(bubble.text).toContain('No answer within 60 min declines it');
    expect(bubble.buttons.map((b) => b.label)).toEqual(['Allow', 'Reject']);
  });

  it('shows the change an edit will make, not just its name', async () => {
    const r = rig({}, EDIT);
    await r.send('change the port');
    const bubble = r.buttonSends.at(-1)!;
    expect(bubble.text).toContain('Edit src/app.ts');
    expect(bubble.text).toContain('-const PORT = 3000;');
    expect(bubble.text).toContain('+const PORT = 8080;');
  });

  it('hands back the option the user tapped, by the agent\'s own id', async () => {
    const r = rig();
    await r.send('make the file');
    await r.click('Reject');
    expect(r.answers).toEqual([{ kind: 'selected', optionId: 'reject' }]);
  });

  it('reports nobody answering as its own outcome, and says so under the bubble', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.daemon.onInbound({ conversation: CONVERSATION, messageId: 'in1', content: 'make the file', timestamp: Date.now(), mentionedSelf: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(r.buttonSends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_ASK_TIMEOUT_MS);
    expect(r.answers).toEqual([{ kind: 'unanswered', waitedMs: DEFAULT_ASK_TIMEOUT_MS }]);
    expect(r.buttonEdits.at(-1)!.text).toContain('not that you refused');
  });

  it('does not take a typed reply as an answer', async () => {
    const r = rig();
    await r.send('make the file');
    await r.send('no, use the other one');
    expect(r.answers).toEqual([]);
  });

  it('cannot ask on a platform without buttons, and says why instead of approving', async () => {
    const r = rig({ buttons: false });
    await r.send('make the file');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.answers).toEqual([{ kind: 'unavailable', why: 'wecom cannot show buttons' }]);
  });

  it('answers a scheduled run as unattended, without posting anything to wait on', async () => {
    const r = rig();
    await r.daemon.registry.runScheduledPrompt({ key: 'tg#c1#', platform: 'tg', address: { channel: 'c1' }, agentId: 'cc', prompt: 'nightly' });
    expect(r.answers).toEqual([{ kind: 'unattended' }]);
    expect(r.buttonSends).toHaveLength(0);
  });
});
