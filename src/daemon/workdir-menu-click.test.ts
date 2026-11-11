import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ButtonInteraction, InboundMessage, MessageRef } from '../types.js';

/**
 * The `/cd` menu end to end: posting it, turning its pages, and clicking one of its directories.
 *
 * Exists for the reason `model-menu-click.test.ts` does — a menu is a snapshot and a click is a
 * later event, so on a button a silent `return` is indistinguishable from a dead one and every
 * path has to end in words. What it adds on top of the model menu's version is that a click here
 * is DESTRUCTIVE: it ends the session the conversation was using. So the two cases worth the most
 * are the ones where it must not be — a re-pick of the current directory, and a menu that has been
 * outlived by a rebind.
 */

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
/** What Telegram actually reports on a click: the callback_query id, not a message id. */
const CALLBACK_QUERY_ID = '4242424242424242';
const MENU_MSG = 'menu-msg-id';

/** What the fake session reports once it has been started — see the factory in rig(). */
const MODELS = {
  current: 'opencode/big-pickle',
  options: [
    { value: 'opencode/big-pickle', name: 'Big Pickle' },
    { value: 'opencode/glm-5', name: 'GLM-5' },
  ],
};

const root = mkdtempSync(join(tmpdir(), 'workdir-click-'));
// Enough projects to force a second page (PAGE_SIZE is 6, and the root takes a slot).
const PROJECTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
for (const name of PROJECTS) mkdirSync(join(root, name));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(access?: string[]): Config {
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude', cwd: root },
      { id: 'oc', harness: 'opencode', cwd: root },
    ],
    routing: {
      default: 'cc',
      pipeline: [
        { when: { command: 'cc' }, use: { agent: 'cc' } },
        { when: { command: 'oc' }, use: { agent: 'oc' } },
      ],
    },
    ...(access ? { access: { allowFrom: access } } : {}),
  });
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function rig(
  opts: {
    access?: string[];
    caps?: { buttons?: boolean; editButtons?: boolean; menuPageSize?: number; workdirPageSize?: number };
  } = {}
) {
  const sent: string[] = [];
  /** Both kinds of post, in the order they were made — which of an ack and a menu came first. */
  const order: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const buttonEdits: Array<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const disposed: string[] = [];
  const starts: string[] = [];
  const sessions = new Map<string, AgentSession>();

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        // Modelled on the ACP runtime: the model list does not exist until the session has been
        // started, which is what made `/model` unanswerable before a conversation's first turn.
        let started = false;
        s = {
          conversationId,
          runTurn: async () => {
            started = true;
          },
          abort: () => {},
          dispose: () => {},
          ensureSession: async (token: string) => {
            starts.push(token);
            started = true;
          },
          modelSelector: () => (started ? MODELS : undefined),
          setModel: async (v: string) => v,
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => {
      disposed.push(id);
      sessions.delete(id);
    },
  };

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: {
      thread: true, editMessage: true, reaction: true, reply: true,
      slashCommands: true, typing: true, maxMessageLength: 4096,
      buttons: opts.caps?.buttons ?? true,
      editButtons: opts.caps?.editButtons ?? true,
      // Left undeclared by default so the existing two-page expectations keep describing the
      // conservative platform; the page-size tests below pass one, and one of them mutates this
      // object mid-flight to prove a live menu is not resized underneath the user.
      ...(opts.caps?.menuPageSize !== undefined ? { menuPageSize: opts.caps.menuPageSize } : {}),
      ...(opts.caps?.workdirPageSize !== undefined ? { workdirPageSize: opts.caps.workdirPageSize } : {}),
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      order.push(`msg:${text}`);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (
      address: { channel: string },
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonSends.push({ text, buttons });
      order.push(`btn:${text}`);
      return { address, messageId: MENU_MSG };
    },
    editButtons: async (
      ref: MessageRef,
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonEdits.push({ messageId: ref.messageId, text, buttons });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const file = join(mkdtempSync(join(tmpdir(), 'workdir-click-store-')), 'conversations.json');
  const store = new ConversationStore(file);
  const daemon = new Daemon(
    config(opts.access),
    new Map([['tg', platform]]),
    agents,
    '/tmp/aa-workdir-menu-test.sock',
    store
  );
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
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const menu = () => buttonSends.at(-1)!;
  const pickIds = () => menu().buttons.filter((b) => b.id.startsWith('wdr:')).map((b) => b.id);
  const navIds = () => menu().buttons.filter((b) => b.id.startsWith('wdp:')).map((b) => b.id);
  const modelIds = () => menu().buttons.filter((b) => b.id.startsWith('mdl:')).map((b) => b.id);
  const key = 'tg#c1#';

  return {
    send, click, replies, menu, pickIds, navIds, modelIds,
    buttonSends, buttonEdits, disposed, starts, store, key, order,
    /** The live capabilities object, so a test can change what the platform claims mid-flight. */
    capabilities: platform.capabilities as { menuPageSize?: number },
  };
}

describe('opening the menu', () => {
  it('posts the directories as buttons on a bare agent command in a fresh conversation', async () => {
    const r = rig();
    await r.send('/cc');
    expect(r.buttonSends).toHaveLength(1);
    expect(r.menu().text).toContain('page 1/2');
    expect(r.menu().text).toContain('starts a fresh session');
    expect(r.pickIds()).toHaveLength(6);
    expect(r.navIds()).toHaveLength(2);
  });

  it('opens on the page holding the current directory', async () => {
    const r = rig();
    await r.send(`/cd ${join(root, 'zeta')}`); // the 6th project — second page, after the root
    await r.send('/cd');
    expect(r.menu().text).toContain('page 2/2');
    expect(r.menu().buttons.some((b) => b.label.startsWith('●'))).toBe(true);
  });

  it('answers as text where buttons cannot be edited (LINE, QQ)', async () => {
    // A menu that can never be paged OR retired would leave live-looking buttons above its own ack.
    const r = rig({ caps: { buttons: true, editButtons: false } });
    await r.send('/cd');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.replies().at(-1)).toContain('Working dir:');
  });

  it('retires the previous menu instead of leaving two live in one conversation', async () => {
    const r = rig();
    await r.send('/cd');
    await r.send('/cd');
    expect(r.buttonEdits.at(-1)!.text).toContain('superseded');
    expect(r.buttonEdits.at(-1)!.buttons).toEqual([]); // an empty array is how a menu is retired
  });
});

describe('turning the page', () => {
  it('edits the same message and keeps indices absolute', async () => {
    const r = rig();
    await r.send('/cd');
    const [prev] = r.navIds();
    await r.click(prev!);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.messageId).toBe(MENU_MSG);
    expect(edit.text).toContain('page 2/2');
    // Second page starts at index 6, not back at 0 — a page turn may never re-point a button.
    expect(edit.buttons[0]!.id.endsWith(':6')).toBe(true);
  });
});

/**
 * How many directories one page holds, and why the daemon freezes that number.
 *
 * The whole point of `menuPageSize` is the first test: on Telegram, a workspace this size is one
 * page, so choosing a directory costs a tap instead of a page turn. The second is the bug the
 * freezing prevents — a click arrives later, and answering it with a re-read page size would draw
 * boundaries the message on screen was never built with.
 */
describe('page size', () => {
  it('fits the whole workspace on one page when the platform says it can', async () => {
    const r = rig({ caps: { menuPageSize: 12 } });
    await r.send('/cc');
    expect(r.pickIds()).toHaveLength(PROJECTS.length + 1); // every project, plus the root
    expect(r.navIds()).toEqual([]); // nothing to turn
    expect(r.menu().text).not.toContain('page 1/');
  });

  it('gives /cd its own page size, leaving the shared one to /model', async () => {
    // The web UI declares both: 24 for /model, 60 for /cd. The shared size is one here, so a leak
    // the other way is visible — /cd would page and /model would not.
    const r = rig({ caps: { menuPageSize: 1, workdirPageSize: PROJECTS.length + 1 } });
    await r.send('/oc');
    expect(r.pickIds()).toHaveLength(PROJECTS.length + 1); // the whole workspace, one page
    expect(r.navIds()).toEqual([]);

    await r.send('/model');
    expect(r.modelIds()).toHaveLength(1); // /model still pages at the shared size
    expect(r.menu().text).toContain('page 1/2');
  });

  it('keeps a posted menu at the size it was drawn with, even if the platform changes its mind', async () => {
    const r = rig({ caps: { menuPageSize: 3 } });
    await r.send('/cd');
    expect(r.pickIds()).toHaveLength(3);
    const [, next] = r.navIds();

    // A config reload (or a profile edit) between the post and the click. The menu on screen still
    // shows three, so page 1 must still mean indices 3–5 — not 12–23 of a list that has eight.
    r.capabilities.menuPageSize = 12;
    await r.click(next!);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.buttons.filter((b) => b.id.startsWith('wdr:'))).toHaveLength(3);
    expect(edit.buttons[0]!.id.endsWith(':3')).toBe(true);
    expect(edit.text).toContain('page 2/3');
  });
});

describe('clicking a directory', () => {
  it('moves the conversation and retires the menu', async () => {
    const r = rig();
    await r.send('/cc');
    const target = r.pickIds()[1]!; // the first project after the root
    await r.click(target);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.text).toContain('Working in');
    expect(edit.buttons).toEqual([]);
    expect(r.store.conversationCwd(r.key)).toBe(join(root, 'alpha'));
    expect(r.disposed).toContain(r.key);
  });

  it('costs nothing when the tap lands on the directory already in use', async () => {
    const r = rig();
    await r.send('/cc');
    r.disposed.length = 0;
    await r.click(r.pickIds()[0]!); // the root, which is where the conversation already is
    expect(r.buttonEdits.at(-1)!.text).toContain('nothing reset');
    expect(r.disposed).toEqual([]);
  });

  it('refuses a menu another agent has taken over, rather than applying it anyway', async () => {
    const r = rig();
    await r.send('/cc');
    const target = r.pickIds()[1]!;
    // Rebind WITH a prompt: a bare `/oc` would open its own menu and retire this one, which is a
    // different (and already-covered) path. Here the stale menu is still live when it is clicked.
    await r.send('/oc have a look');
    await r.click(target);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.text).toContain('no longer applies');
    expect(r.store.conversationCwd(r.key)).toBeUndefined();
  });

  it('answers a click on a menu the daemon no longer knows about', async () => {
    const r = rig();
    await r.send('/cc');
    const target = r.pickIds()[1]!;
    await r.click(target); // uses the menu up
    await r.click(target); // …and again
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('ignores a click from outside the allowlist', async () => {
    const r = rig({ access: ['tg:u1'] });
    await r.send('/cc');
    const target = r.pickIds()[1]!;
    const editsBefore = r.buttonEdits.length;
    await r.click(target, 'intruder');
    expect(r.buttonEdits).toHaveLength(editsBefore);
    expect(r.store.conversationCwd(r.key)).toBeUndefined();
  });
});

/**
 * The reported bug, end to end: a fresh topic where the user sends `/oc`, picks a directory from
 * the buttons, and then wants a model — the sequence the directory menu itself invites.
 *
 * It used to answer "No model selector on this session yet — send a message, then /model", which
 * was both wrong and unactionable: under ACP the model list arrives with `session/new`, so nothing
 * short of a turn would produce one, and picking a directory had just disposed the session anyway.
 */
describe('choosing a model straight after choosing a directory', () => {
  it('offers the models once a directory has been picked, without a turn in between', async () => {
    const r = rig();
    await r.send('/oc');
    await r.click(r.pickIds()[1]!); // pick a project
    expect(r.store.conversationCwd(r.key)).toBe(join(root, PROJECTS[0]!));

    await r.send('/model');
    expect(r.starts).toHaveLength(1); // the session was started for the menu, deliberately
    expect(r.modelIds()).toHaveLength(2); // …and the models are on offer as buttons
  });

  it('offers the models on a bare /oc that was never followed by anything', async () => {
    const r = rig();
    await r.send('/oc'); // directory menu posted, nothing picked, no turn run
    await r.send('/model');
    expect(r.modelIds()).toHaveLength(2);
  });

  // `/cd` in an ESTABLISHED conversation is the second, independent repro: setWorkdir disposes the
  // session to move it, which drops the closure holding the model list. Warming on demand covers
  // this case for free, and it is worth pinning because the dispose is the whole point of `/cd`.
  it('offers the models again after /cd has moved an established conversation', async () => {
    const r = rig();
    await r.send('/oc do some work'); // a real turn: the conversation is now established
    await r.send('/cd beta');
    expect(r.disposed).toContain(r.key);

    await r.send('/model');
    expect(r.modelIds()).toHaveLength(2);
  });
});

/**
 * `/agent <id>` — typed, picked from the `/agent` menu, or tapped on the web UI's new topic, which
 * types it — asks where the agent should work, as a bare `/cc` does. Before, choosing by id was the
 * one way into a fresh conversation that skipped the question, so every agent chosen that way
 * started in its root.
 */
describe('choosing an agent by id asks where it should work', () => {
  it('posts the directory menu under the ack, in a conversation that has never run', async () => {
    const r = rig();
    await r.send('/agent oc');
    expect(r.replies()).toContain('▸ opencode is answering this conversation now');
    expect(r.menu().text).toContain('Working dir:');
    // Under the line saying who it is for, not above it.
    expect(r.order.map((o) => o.slice(0, 4))).toEqual(['msg:', 'btn:']);

    await r.click(r.pickIds()[1]!);
    expect(r.store.boundAgent(r.key)).toBe('oc');
    expect(r.store.conversationCwd(r.key)).toBe(join(root, PROJECTS[0]!));
  });

  it('does the same for a pick from the /agent menu', async () => {
    const r = rig();
    await r.send('/agent');
    const pick = r.menu().buttons.find((b) => b.label.includes('oc'))!;
    await r.click(pick.id);
    expect(r.buttonEdits.at(-1)?.text).toBe('▸ opencode is answering this conversation now');
    expect(r.buttonSends).toHaveLength(2);
    expect(r.menu().text).toContain('Working dir:');
  });

  it('does not ask once that agent has a session here: its directory is fixed', async () => {
    const r = rig();
    await r.send('/oc do some work');
    r.store.setAgentSession(r.key, 'oc', 'acp-oc-1');
    const menus = r.buttonSends.length;
    await r.send('/agent oc');
    expect(r.replies().at(-1)).toContain('already answering');
    expect(r.buttonSends).toHaveLength(menus);
  });

  it('does not ask when the switch was refused', async () => {
    const r = rig();
    await r.send('hello'); // cc, by default
    r.store.setAgentSession(r.key, 'cc', 'acp-cc-1');
    await r.send('/agent oc');
    expect(r.store.boundAgent(r.key)).toBe('cc');
    expect(r.buttonSends).toHaveLength(0);
  });
});
