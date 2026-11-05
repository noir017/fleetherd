import { describe, expect, it } from 'vitest';
import { Daemon } from './daemon.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { ModelPickerList, ModelPickerResult, PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ButtonInteraction, InboundMessage, MessageRef, ModelSelector } from '../types.js';

/**
 * The `/model` menu: a bare `/model` posts the model list as buttons, ◀ ▶ turn the page on the same
 * message, and a tap switches the model.
 *
 * What this file is really guarding is that no path ends in silence. A menu is a snapshot and a
 * click is a later event, so almost everything it assumed can have changed by the time it arrives —
 * the conversation reset, the agent rebound, the harness rebuilt its list — and on a button, a
 * silent `return` is indistinguishable from a dead button. Every one of those cases gets words here.
 *
 * The other half is the frozen snapshot: a pick id names a position in the list the menu was OPENED
 * with, and the value it resolves to is re-checked against the live selector before anything is
 * switched. Without that pairing a rebuilt list would let a stale index switch to a model the user
 * never saw.
 */

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
/** What Telegram actually reports on a click: the callback_query id, not a message id. */
const CALLBACK_QUERY_ID = '4242424242424242';
const MENU_MSG = 'menu-msg-id';

function config(access?: string[]): Config {
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'oc', harness: 'opencode' },
      { id: 'cc', harness: 'claude' },
    ],
    routing: {
      default: 'oc',
      pipeline: [{ when: { command: 'cc' }, use: { agent: 'cc' } }],
    },
    ...(access ? { access: { allowFrom: access } } : {}),
  });
  // Shrink the merge window so a routed message dispatches promptly. Applied post-parse: `inbound`
  // is part of the frozen EXPERIENCE block and would be discarded from the input.
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const OPTIONS = [
  { value: 'opencode/big-pickle', name: 'Big Pickle' },
  { value: 'opencode/hy3-free', name: 'HY3' },
  { value: 'opencode/mimo-v2.5-free', name: 'MiMo' },
  { value: 'newapi/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { value: 'newapi/GLM-5.2', name: 'GLM-5.2' },
  { value: 'newapi/glm-4.7-flash', name: 'GLM-4.7-Flash' },
  { value: 'newapi/sensenova-glm-5.2', name: '(sensenova) GLM-5.2' },
  { value: 'newapi/nvidia-deepseek-v4-flash', name: '(nvidia) DeepSeek-V4-Flash' },
];

interface RigOptions {
  /** Access allowlist, when the test is about who may click. */
  access?: string[];
  /** Start with no live selector (as before the agent's first reply). */
  noSelector?: boolean;
  /** Platform capabilities to override (buttons / editButtons). */
  caps?: { buttons?: boolean; editButtons?: boolean };
}

function rig(opts: RigOptions = {}) {
  const sent: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const buttonEdits: Array<{
    messageId: string;
    text: string;
    buttons: Array<{ id: string; label: string }>;
  }> = [];
  const setModelCalls: string[] = [];
  const sessions = new Map<string, AgentSession>();
  /** What the harness's list becomes when re-asked; unset means re-asking changes nothing. */
  const onRefresh: { fn?: () => void; calls: number } = { calls: 0 };

  /** Mutable so a test can rebuild the harness's list under an open menu. */
  const selector: { value: ModelSelector | undefined } = {
    value: opts.noSelector ? undefined : { current: 'opencode/big-pickle', options: [...OPTIONS] },
  };

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async () => {},
          abort: () => {},
          dispose: () => {},
          modelSelector: () => selector.value,
          refreshModels: async () => {
            onRefresh.calls++;
            onRefresh.fn?.();
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
      buttons: opts.caps?.buttons ?? true,
      editButtons: opts.caps?.editButtons ?? true,
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

  const cfg = config(opts.access);
  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, '/tmp/aa-model-menu-test.sock');
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
    d.onButton({
      conversation: { ...CONVERSATION, user },
      messageId: CALLBACK_QUERY_ID,
      buttonId,
    });
    await drain();
  };
  /** Text the gateway sent that is not the header bubble. */
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const menu = () => buttonSends.at(-1)!;
  const pickIds = () => menu().buttons.filter((b) => b.id.startsWith('mdl:')).map((b) => b.id);
  const navIds = () => menu().buttons.filter((b) => b.id.startsWith('mpg:')).map((b) => b.id);

  const registry = (daemon as unknown as {
    registry: {
      modelPickerForRef(ref: typeof CONVERSATION): Promise<ModelPickerList>;
      chooseModelForRef(ref: typeof CONVERSATION, value: string): Promise<ModelPickerResult>;
    };
  }).registry;

  return {
    send, click, replies, menu, pickIds, navIds, selector, onRefresh,
    sent, buttonSends, buttonEdits, setModelCalls,
    cfg, agents, platform, registry,
  };
}

describe('opening the menu', () => {
  it('posts buttons instead of the text answer', async () => {
    const r = rig();
    await r.send('/model');
    expect(r.buttonSends).toHaveLength(1);
    expect(r.replies()).toEqual([]); // the text surface must not also fire
    expect(r.menu().text).toContain('page 1/2');
  });

  it('opens on the page holding the current model, not always the first', async () => {
    const r = rig();
    r.selector.value = { current: 'newapi/nvidia-deepseek-v4-flash', options: [...OPTIONS] }; // last of 8
    await r.send('/model');
    expect(r.menu().text).toContain('page 2/2');
    expect(r.menu().buttons.some((b) => b.label.startsWith('●'))).toBe(true);
  });

  it('still answers as text when the harness offers no selector', async () => {
    const r = rig({ noSelector: true });
    await r.send('/model');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.replies().at(-1)).toContain('offers no model selector');
  });

  it('answers as text on a platform with no buttons', async () => {
    const r = rig({ caps: { buttons: false, editButtons: false } });
    await r.send('/model');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.replies().at(-1)).toContain('8 available');
  });

  it('answers as text where buttons exist but cannot be edited (LINE, QQ)', async () => {
    // A menu that can never be paged OR retired would leave live-looking buttons above its own ack.
    const r = rig({ caps: { buttons: true, editButtons: false } });
    await r.send('/model');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.replies().at(-1)).toContain('8 available');
  });

  it('opens for the claude agent too, which has no native /model to translate to', async () => {
    // claude's adapter does not advertise `model` (probed live), so a forwarded /model was a prompt
    // that cost a turn and printed text to type against. It exposes the selector over the protocol
    // like opencode does, so it gets the same menu.
    const r = rig();
    await r.send('/cc');
    await r.send('/model');
    expect(r.buttonSends).toHaveLength(1);
    await r.click(r.pickIds()[4]!);
    expect(r.setModelCalls).toEqual(['newapi/GLM-5.2']);
  });

  it('leaves `/model <query>` on the text path, opening no menu', async () => {
    const r = rig();
    await r.send('/model glm-4.7');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.setModelCalls).toEqual(['newapi/glm-4.7-flash']);
  });
});

describe('a list that grew while the daemon ran', () => {
  // agy's list is fetched outside the session and is served by Google, so it changes under a
  // running daemon: Opus 5.5 appeared on 2026-10-03 and a daemon from 09-29 never offered it.
  const OPUS = { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' };
  function grown() {
    const r = rig();
    r.onRefresh.fn = () => {
      r.selector.value = { current: 'opencode/big-pickle', options: [OPUS, ...OPTIONS] };
    };
    return r;
  }

  it('the menu shows a model the harness added since the daemon started', async () => {
    const r = grown();
    await r.send('/model');
    expect(r.onRefresh.calls).toBe(1);
    expect(r.menu().buttons.some((b) => b.label.includes('Opus 5.5'))).toBe(true);
  });

  it('`/model <query>` matches against the re-asked list', async () => {
    const r = grown();
    await r.send('/model opus-5-5');
    expect(r.setModelCalls).toEqual(['claude-opus-5-5-medium']);
  });

  it('a click on that menu does not re-ask — the /model that opened it just did', async () => {
    const r = grown();
    await r.send('/model');
    const pick = r.menu().buttons.find((b) => b.label.includes('Opus 5.5'))!;
    await r.click(pick.id);
    expect(r.setModelCalls).toEqual(['claude-opus-5-5-medium']);
    expect(r.onRefresh.calls).toBe(1);
  });
});

describe('turning the page', () => {
  it('edits the same message rather than posting a new menu', async () => {
    const r = rig();
    await r.send('/model');
    await r.click(r.navIds()[1]!); // Next ▶
    expect(r.buttonSends).toHaveLength(1); // no repost
    expect(r.buttonEdits).toHaveLength(1);
    expect(r.buttonEdits[0]!.messageId).toBe(MENU_MSG);
    expect(r.buttonEdits[0]!.text).toContain('page 2/2');
  });

  it('is not one-shot: a menu survives repeated paging and still picks afterwards', async () => {
    const r = rig();
    await r.send('/model');
    const [prev, next] = [r.navIds()[0]!, r.navIds()[1]!];
    await r.click(next);
    await r.click(prev);
    await r.click(next);
    expect(r.buttonEdits).toHaveLength(3);
    await r.click(r.pickIds()[4]!); // 'newapi/GLM-5.2'
    expect(r.setModelCalls).toEqual(['newapi/GLM-5.2']);
  });

  it('addresses the menu ref captured from the send, never the click event id', async () => {
    // On Telegram ev.messageId is the callback_query id — editing it 400s and the caller swallows
    // it, which is how the picker's click ack silently never applied.
    const r = rig();
    await r.send('/model');
    await r.click(r.navIds()[1]!);
    expect(r.buttonEdits[0]!.messageId).not.toBe(CALLBACK_QUERY_ID);
  });
});

describe('picking a model', () => {
  it('switches, acks on the menu, and strips the buttons', async () => {
    const r = rig();
    await r.send('/model');
    await r.click(r.pickIds()[4]!);
    expect(r.setModelCalls).toEqual(['newapi/GLM-5.2']);
    const ack = r.buttonEdits.at(-1)!;
    expect(ack.text).toContain('newapi/GLM-5.2');
    // An empty array, not editMessage: only Discord and Telegram drop components on a text edit.
    expect(ack.buttons).toEqual([]);
  });

  it('is one-shot: the same button clicked again says the menu expired', async () => {
    const r = rig();
    await r.send('/model');
    const id = r.pickIds()[4]!;
    await r.click(id);
    await r.click(id);
    expect(r.setModelCalls).toEqual(['newapi/GLM-5.2']); // not twice
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('refuses a value the harness no longer offers, rather than switching by stale index', async () => {
    // THE reason the snapshot is re-validated by value: the harness can rebuild its list mid-session
    // (config_option_update, a session recreated after a timeout), and index 4 of the new list is a
    // different model than index 4 of the one on screen.
    const r = rig();
    await r.send('/model');
    const id = r.pickIds()[4]!; // newapi/GLM-5.2 in the snapshot
    r.selector.value = { current: 'opencode/big-pickle', options: OPTIONS.slice(0, 3) };
    await r.click(id);
    expect(r.setModelCalls).toEqual([]);
    expect(r.buttonEdits.at(-1)!.text).toContain('no longer offered');
    expect(r.buttonEdits.at(-1)!.buttons).toEqual([]);
  });

  it('says the session is gone rather than throwing when /new cleared it', async () => {
    const r = rig();
    await r.send('/model');
    const id = r.pickIds()[4]!;
    r.selector.value = undefined; // the child was disposed; modelSelector is non-spawning
    await r.click(id);
    expect(r.setModelCalls).toEqual([]);
    expect(r.buttonEdits.at(-1)!.text).toContain('No live session');
    // A transient state, so the menu stays clickable for a retry.
    expect(r.buttonEdits.at(-1)!.buttons.length).toBeGreaterThan(0);
  });

  it('refuses when another agent has taken over the conversation', async () => {
    const r = rig();
    await r.send('/model');
    const id = r.pickIds()[4]!;
    await r.send('/cc'); // rebind to the claude agent
    await r.click(id);
    expect(r.setModelCalls).toEqual([]);
    expect(r.buttonEdits.at(-1)!.text).toContain('claude');
  });
});

describe('menu lifetime', () => {
  it('a second /model supersedes the first, and the old buttons say so', async () => {
    const r = rig();
    await r.send('/model');
    const stale = r.pickIds()[4]!;
    await r.send('/model');
    // The first menu was retired in place, buttons stripped.
    expect(r.buttonEdits[0]!.text).toContain('superseded');
    expect(r.buttonEdits[0]!.buttons).toEqual([]);
    await r.click(stale);
    expect(r.setModelCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('a click after a restart is answered, not ignored', async () => {
    const r = rig();
    await r.send('/model');
    const id = r.pickIds()[4]!;
    const fresh = rig(); // a new daemon: pendingModelMenus is in-memory
    await fresh.click(id);
    expect(fresh.setModelCalls).toEqual([]);
    expect(fresh.replies().at(-1)).toContain('expired');
  });

  it('a mangled index is answered rather than silently dropped', async () => {
    const r = rig();
    await r.send('/model');
    const reqId = r.pickIds()[0]!.split(':')[1]!;
    await r.click(`mdl:${reqId}:999`);
    expect(r.setModelCalls).toEqual([]);
    expect(r.replies().at(-1)).toContain('expired');
  });
});

describe('access control', () => {
  it('a click from outside the allowlist changes nothing', async () => {
    // A menu in a shared channel can be pressed by someone other than whoever opened it, and this
    // click changes which model answers for everyone in the conversation.
    const r = rig({ access: ['tg:u1'] });
    await r.send('/model');
    await r.click(r.pickIds()[4]!, 'intruder');
    expect(r.setModelCalls).toEqual([]);
    expect(r.buttonEdits).toHaveLength(0);
  });

  it('the allowlisted user is unaffected', async () => {
    const r = rig({ access: ['tg:u1'] });
    await r.send('/model');
    await r.click(r.pickIds()[4]!, 'u1');
    expect(r.setModelCalls).toEqual(['newapi/GLM-5.2']);
  });
});

describe('the model switch a platform draws (useModelPicker)', () => {
  it('lists what the conversation can switch to, binding a new one as its first message would', async () => {
    const r = rig();
    const list = await r.registry.modelPickerForRef(CONVERSATION);
    expect(list).toMatchObject({ ok: true, agent: 'oc', current: 'opencode/big-pickle' });
    if (!list.ok) throw new Error('no list');
    expect(list.options.map((o) => o.value)).toEqual(OPTIONS.map((o) => o.value));
    // Re-asked, as /model re-asks: a list served outside the session may have grown.
    expect(r.onRefresh.calls).toBe(1);
  });

  it('switches the way /model does, and the override is the one /model reads', async () => {
    const r = rig();
    await r.send('hello');
    const result = await r.registry.chooseModelForRef(CONVERSATION, 'newapi/GLM-5.2');
    expect(result).toEqual({ ok: true, model: 'newapi/GLM-5.2', text: 'Model set to `newapi/GLM-5.2` for this conversation.' });
    expect(r.setModelCalls).toEqual(['newapi/GLM-5.2']);
    const list = await r.registry.modelPickerForRef(CONVERSATION);
    expect(list.ok && list.override).toBe('newapi/GLM-5.2');
  });

  it('refuses a model the agent does not offer, in /model’s words', async () => {
    const r = rig();
    await r.send('hello');
    const result = await r.registry.chooseModelForRef(CONVERSATION, 'newapi/not-there');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('is no longer offered by this agent');
    expect(r.setModelCalls).toEqual([]);
  });

  it('says why there is no list for a harness that offers no model choice', async () => {
    const r = rig({ noSelector: true });
    const list = await r.registry.modelPickerForRef(CONVERSATION);
    expect(list).toMatchObject({ ok: false, agent: 'oc', reason: 'none' });
  });

  it('cannot switch a conversation that does not exist', async () => {
    const r = rig();
    const result = await r.registry.chooseModelForRef({ ...CONVERSATION, channel: 'nowhere' }, 'newapi/GLM-5.2');
    expect(result).toEqual({ ok: false, text: 'That conversation is gone — send a message first, then /model.' });
  });
});
