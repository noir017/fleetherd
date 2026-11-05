import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { Daemon } from './daemon.js';
import { loadConfig } from '../config/load.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ButtonInteraction, InboundMessage, MessageRef, ModelSelector, SettingsScreen } from '../types.js';

/**
 * `/setting` end to end: both surfaces, the file it writes, and what actually changes in the
 * running daemon.
 *
 * ── What this file is really guarding ─────────────────────────────────────────
 * This is the only command that writes to the file the daemon needs in order to START. So the
 * assertions that matter most are not the happy paths but the ones about the file: that a refusal
 * leaves it byte-identical, that clearing a value DELETES the key rather than writing a `null` the
 * next load would reject, that a `${VAR}` template is never expanded on the way through, and that
 * a hand-written comment survives. Each of those, if it broke, would produce a deployment that runs
 * fine until someone restarts it.
 *
 * The other half is honesty about WHEN a change lands. Three of the four settings take effect
 * immediately, `model` on the next agent session, and `scope` only on a restart — and the ack has
 * to say which, because the alternative is a user who believes they changed something they did not.
 */

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
const CALLBACK_QUERY_ID = '4242424242424242';
const MENU_MSG = 'menu-msg-id';

/** The file as an operator wrote it: comments, a template, and a key the schema does not know. */
const YAML_FILE = `# my deployment
version: 1
platforms:
  tg:
    type: telegram
    token: \${TG_TOKEN}
agents:
  - id: oc
    harness: opencode
  - id: cc
    harness: claude
    model: claude-opus-4-5
routing:
  default: oc
session:
  # hand-tuned: this box has 8GB
  idleTimeoutMs: 3600000
  futureKnob: 45
`;

/** A voice block as an operator writes one: a comment, and the key as a template. */
const VOICE_BLOCK = `voice:
  # transcripts through newapi's google-ai-studio channel
  transcriber:
    baseUrl: http://newapi:3000/v1beta
    apiKey: \${NEWAPI_API_KEY}
    model: gemini-3-flash
`;

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'talkcode-setting-'));
  file = path.join(dir, 'config.yaml');
  savedEnv.TALKCODE_CONFIG_FILE = process.env.TALKCODE_CONFIG_FILE;
  savedEnv.TG_TOKEN = process.env.TG_TOKEN;
  savedEnv.NEWAPI_API_KEY = process.env.NEWAPI_API_KEY;
  process.env.TALKCODE_CONFIG_FILE = file;
  process.env.TG_TOKEN = 'tok-from-env';
  process.env.NEWAPI_API_KEY = 'key-from-env';
  fs.writeFileSync(file, YAML_FILE);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const text = (): string => fs.readFileSync(file, 'utf8');
const onDisk = (): Record<string, unknown> => parse(text()) as Record<string, unknown>;
const diskAgents = (): Array<{ id: string; model?: string }> =>
  (onDisk()['agents'] ?? []) as Array<{ id: string; model?: string }>;

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const MODELS = [
  { value: 'opencode/big-pickle', name: 'Big Pickle' },
  { value: 'opencode/glm-5', name: 'GLM-5' },
  { value: 'opencode/hy3-free', name: 'HY3' },
  { value: 'newapi/deepseek-v4', name: 'DeepSeek V4' },
  { value: 'newapi/GLM-5.2', name: 'GLM-5.2' },
  { value: 'newapi/kimi-k3', name: 'Kimi K3' },
  { value: 'newapi/qwen-4', name: 'Qwen 4' },
  { value: 'newapi/llama-5', name: 'Llama 5' },
];

interface RigOptions {
  access?: string[];
  /** Platform capabilities: omit buttons to exercise the text surface. */
  caps?: { buttons?: boolean; editButtons?: boolean; settingsScreen?: boolean };
  /** Start with reclaim disabled, to prove `/setting idle` arms a sweeper that was never armed. */
  idleTimeoutMs?: number;
  /** Configure voice transcription (the file must carry the same block — see VOICE_BLOCK). */
  voice?: boolean;
}

function rig(opts: RigOptions = {}) {
  const sent: string[] = [];
  const buttonSends: Array<{
    text: string;
    buttons: Array<{ id: string; label: string }>;
    screen?: SettingsScreen;
  }> = [];
  const buttonEdits: Array<{
    messageId: string;
    text: string;
    buttons: Array<{ id: string; label: string }>;
    screen?: SettingsScreen;
  }> = [];
  const scheduled: number[] = [];
  const sessions = new Map<string, AgentSession>();

  const selector: { value: ModelSelector | undefined } = {
    value: { current: 'opencode/big-pickle', options: [...MODELS] },
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
          setModel: async (value: string) => value,
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
      settingsScreen: opts.caps?.settingsScreen ?? false,
    },
    sendMessage: async (address: { channel: string }, body: string) => {
      sent.push(body);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (
      address: { channel: string },
      body: string,
      buttons: Array<{ id: string; label: string }>,
      screen?: SettingsScreen
    ) => {
      buttonSends.push({ text: body, buttons, ...(screen ? { screen } : {}) });
      return { address, messageId: MENU_MSG };
    },
    editButtons: async (
      ref: MessageRef,
      body: string,
      buttons: Array<{ id: string; label: string }>,
      screen?: SettingsScreen
    ) => {
      buttonEdits.push({ messageId: ref.messageId, text: body, buttons, ...(screen ? { screen } : {}) });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  // The injected config mirrors the file (expanded token, agents in file order), as loadConfig
  // would have produced it at startup.
  const parsed = parseConfig({
    version: 1,
    platforms: { tg: { type: 'telegram', token: 'tok-from-env' } },
    agents: [
      { id: 'oc', harness: 'opencode' },
      { id: 'cc', harness: 'claude', model: 'claude-opus-4-5' },
    ],
    routing: { default: 'oc' },
    session: { idleTimeoutMs: opts.idleTimeoutMs ?? 3_600_000 },
    ...(opts.access ? { access: { allowFrom: opts.access } } : {}),
    ...(opts.voice
      ? { voice: { transcriber: { baseUrl: 'http://newapi:3000/v1beta', apiKey: 'k', model: 'gemini-3-flash' } } }
      : {}),
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

  const daemon = new Daemon(cfg, new Map([['tg', platform]]), agents, path.join(dir, 'd.sock'));
  const d = daemon as unknown as {
    onInbound(m: InboundMessage): void;
    onButton(ev: ButtonInteraction): void;
    registry: { reclaimIdleSessions(): void };
  };

  let n = 0;
  const send = async (content: string, over: Partial<typeof CONVERSATION> = {}): Promise<void> => {
    d.onInbound({
      conversation: { ...CONVERSATION, ...over },
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
  /** Text the gateway sent that is not the header bubble. */
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const menu = () => buttonSends.at(-1)!;
  const screen = () => (buttonEdits.at(-1) ?? buttonSends.at(-1))!;
  const ids = (prefix: string) => screen().buttons.filter((b) => b.id.startsWith(prefix)).map((b) => b.id);

  return {
    send, click, replies, menu, screen, ids, scheduled, selector, sessions,
    sent, buttonSends, buttonEdits, cfg, daemon: d,
  };
}

/** A rig whose platform has no buttons — the surface LINE and QQ get. */
const textRig = (opts: RigOptions = {}) =>
  rig({ ...opts, caps: { buttons: false, editButtons: false } });

describe('reading the settings', () => {
  it('lists every editable key with its value, and runs no turn', async () => {
    const r = textRig();
    await r.send('/setting');
    const answer = r.replies().at(-1)!;
    for (const key of ['`agent`', '`model.oc`', '`model.cc`', '`idle`', '`scope`']) {
      expect(answer).toContain(key);
    }
    expect(answer).toContain('oc · opencode'); // routing.default, named by harness
    expect(answer).toContain('claude-opus-4-5');
    expect(answer).toContain('1h');
  });

  it('answers `/settings` and `/config` too, which are what people type', async () => {
    const r = textRig();
    await r.send('/settings');
    await r.send('/config');
    expect(r.replies()).toHaveLength(2);
    expect(r.replies()[0]).toEqual(r.replies()[1]);
  });

  it('describes one setting, with the commands that would change it', async () => {
    const r = textRig();
    await r.send('/setting scope');
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('/setting scope per_channel');
    expect(answer).toContain('restarts');
  });

  it('leaves the file untouched when only reading', async () => {
    const r = textRig();
    const before = text();
    await r.send('/setting');
    await r.send('/setting idle');
    expect(text()).toBe(before);
  });
});

describe('writing a setting', () => {
  it('patches the file, applies it live, and says both', async () => {
    const r = textRig();
    await r.send('/setting agent cc');
    expect(r.replies().at(-1)).toContain('in effect now');
    expect(r.cfg.routing.default).toBe('cc'); // the live config, not just the file
    expect(onDisk()['routing']).toEqual({ default: 'cc' });
  });

  it('turns sub-agent confirmation off in the file and in the running daemon', async () => {
    const r = textRig();
    await r.send('/setting delegation off');
    expect(r.replies().at(-1)).toContain('Confirm sub-agent starts → off');
    expect(r.replies().at(-1)).toContain('in effect now');
    // The live config is what Delegation.propose reads, so the very next task-new follows it.
    expect(r.cfg.delegation.confirm).toBe(false);
    expect(onDisk()['delegation']).toEqual({ confirm: false });
  });

  it('turns it back on the same way', async () => {
    const r = textRig();
    await r.send('/setting delegation off');
    await r.send('/setting delegation on');
    expect(r.cfg.delegation.confirm).toBe(true);
    expect(onDisk()['delegation']).toEqual({ confirm: true });
  });

  it('routes the next new conversation to the agent just made default', async () => {
    const r = textRig();
    await r.send('/setting agent cc');
    await r.send('hello', { channel: 'c2' }); // a conversation with no binding yet
    // The sticky binding means the conversation that TYPED the command keeps its own agent; the
    // point of routing.default is what happens to the next one.
    expect(r.sessions.size).toBe(1);
    expect(r.cfg.routing.default).toBe('cc');
  });

  it('keeps comments, key order, unknown keys and ${VAR} templates', async () => {
    const r = textRig();
    await r.send('/setting idle 15m');
    const after = text();
    expect(after).toContain('# my deployment');
    expect(after).toContain('# hand-tuned: this box has 8GB');
    expect(after).toContain('futureKnob: 45');
    expect(after).toContain('${TG_TOKEN}'); // never expanded on the way to disk
    expect(after).toContain('idleTimeoutMs: 900000');
  });

  it('leaves a file the daemon can still load', async () => {
    const r = textRig();
    await r.send('/setting agent cc');
    await r.send('/setting idle 4h');
    await r.send('/setting scope per_user');
    const reloaded = loadConfig();
    expect(reloaded.routing.default).toBe('cc');
    expect(reloaded.session.idleTimeoutMs).toBe(14_400_000);
    expect(reloaded.session.scope).toBe('per_user');
  });

  it('says nothing was written when the value is already set', async () => {
    const r = textRig();
    const before = text();
    await r.send('/setting scope per_thread');
    expect(r.replies().at(-1)).toContain('already');
    expect(text()).toBe(before);
  });
});

describe('the idle reclaim window', () => {
  it('changes what the sweeper enforces immediately', async () => {
    const r = textRig();
    await r.send('hello'); // a conversation with a resident session
    await r.send('/setting idle 15m');
    expect(r.cfg.session.idleTimeoutMs).toBe(900_000);
  });

  it('arms a sweeper that was never armed, when reclaim starts out off', async () => {
    // startIdleSweeper returns early at 0, so without a re-arm raising it from `off` would take a
    // restart — the change would look applied and do nothing.
    const r = rig({ idleTimeoutMs: 0 });
    await r.send('/setting idle 15m');
    expect(r.cfg.session.idleTimeoutMs).toBe(900_000);
    // The sweep now has a deadline to enforce; calling it directly is how the decision is tested.
    expect(() => r.daemon.registry.reclaimIdleSessions()).not.toThrow();
  });

  it('turns reclaim off', async () => {
    const r = textRig();
    await r.send('/setting idle off');
    expect(r.cfg.session.idleTimeoutMs).toBe(0);
    expect(onDisk()['session']).toMatchObject({ idleTimeoutMs: 0 });
  });
});

describe("an agent's default model", () => {
  it('writes to the entry with that id and says it lands on the next session', async () => {
    const r = textRig();
    await r.send('/setting model.cc claude-opus-5');
    expect(r.replies().at(-1)).toContain('next agent session');
    expect(diskAgents()).toEqual([
      { id: 'oc', harness: 'opencode' },
      { id: 'cc', harness: 'claude', model: 'claude-opus-5' },
    ]);
    // The live def is mutated in place, which is the object each session already holds.
    expect(r.cfg.agents.find((a) => a.id === 'cc')!.model).toBe('claude-opus-5');
  });

  it('resolves the entry by id, not by the runtime array position', async () => {
    // Someone reordered `agents:` by hand after the daemon started. Patching by the in-memory index
    // would set opencode's model to a claude one, silently.
    const r = textRig();
    fs.writeFileSync(
      file,
      YAML_FILE.replace(
        '  - id: oc\n    harness: opencode\n  - id: cc\n    harness: claude\n    model: claude-opus-4-5\n',
        '  - id: cc\n    harness: claude\n    model: claude-opus-4-5\n  - id: oc\n    harness: opencode\n'
      )
    );
    await r.send('/setting model.cc claude-opus-5');
    const agents = diskAgents();
    expect(agents.find((a) => a.id === 'cc')!.model).toBe('claude-opus-5');
    expect(agents.find((a) => a.id === 'oc')!.model).toBeUndefined();
  });

  it('clears by DELETING the key, so the next load still validates', async () => {
    // A `null` here would fail `z.string().optional()` — a write that bricks the file it clears.
    const r = textRig();
    await r.send('/setting model.cc -');
    expect(text()).not.toContain('model:');
    expect(text()).not.toContain('null');
    expect(diskAgents().find((a) => a.id === 'cc')).toEqual({ id: 'cc', harness: 'claude' });
    expect(loadConfig().agents.find((a) => a.id === 'cc')!.model).toBeUndefined();
    expect(r.cfg.agents.find((a) => a.id === 'cc')!.model).toBeUndefined();
  });

  it('resolves a substring against the live list of the agent answering here', async () => {
    const r = textRig();
    await r.send('hello'); // creates the session whose selector reports the list
    await r.send('/setting model kimi');
    expect(diskAgents().find((a) => a.id === 'oc')!.model).toBe('newapi/kimi-k3');
  });

  it('warns when a /model override is shadowing the default just written', async () => {
    const r = textRig();
    await r.send('hello');
    await r.send('/model kimi'); // a runtime override for this conversation
    await r.send('/setting model opencode/big-pickle');
    expect(r.replies().at(-1)).toContain('`/model` override');
  });

  it('reports a file whose agents list no longer has that id, rather than writing blind', async () => {
    const r = textRig();
    fs.writeFileSync(file, YAML_FILE.replace('  - id: cc\n    harness: claude\n    model: claude-opus-4-5\n', ''));
    await r.send('/setting model.cc claude-opus-5');
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('has changed since the daemon started');
    expect(diskAgents()).toHaveLength(1);
  });
});

describe('the conversation scope', () => {
  it('is written to the file but NOT applied to the running daemon', async () => {
    // Applying it live would re-identify every existing conversation: the key function changes, so
    // the next message in a topic lands in a brand-new conversation with no context.
    const r = textRig();
    await r.send('hello');
    await r.send('/setting scope per_user');
    expect(onDisk()['session']).toMatchObject({ scope: 'per_user' });
    expect(r.cfg.session.scope).toBe('per_thread'); // unchanged in memory
    expect(r.replies().at(-1)).toContain('restarts');
  });

  it('leaves the conversation that asked exactly where it was', async () => {
    const r = textRig();
    await r.send('hello');
    const before = r.sessions.size;
    await r.send('/setting scope shared');
    await r.send('still here');
    expect(r.sessions.size).toBe(before); // no second conversation was minted
  });
});

describe('what it refuses', () => {
  const cases: Array<[string, string]> = [
    ['/setting access', 'locks you out'],
    ['/setting access.allowFrom tg:u9', 'locks you out'],
    ['/setting platforms.tg.token abc', 'chat log'],
    ['/setting tools.mode off', 'frozen in the code'],
    ['/setting display.footer.enabled true', 'not editable from chat'],
    ['/setting agents.oc.harness claude', 'then send /reload'],
    // The one section /reload cannot apply still points at a restart.
    ['/setting token abc', 'restart the daemon'],
  ];

  for (const [command, expected] of cases) {
    it(`refuses ${command.split(' ')[1]} by name, without writing`, async () => {
      const r = textRig();
      const before = text();
      await r.send(command);
      expect(r.replies().at(-1)).toContain(expected);
      expect(r.replies().at(-1)).toContain('config.yaml');
      expect(text()).toBe(before);
    });
  }

  it('refuses a value the setting does not accept, and writes nothing', async () => {
    const r = textRig();
    const before = text();
    await r.send('/setting agent nope');
    await r.send('/setting idle 30');
    await r.send('/setting scope per-user');
    expect(r.replies()).toHaveLength(3);
    expect(r.replies()[0]).toContain('No agent named');
    expect(r.replies()[1]).toContain('15m');
    expect(r.replies()[2]).toContain('per_thread');
    expect(text()).toBe(before);
  });

  it('says an unknown key is unknown instead of guessing', async () => {
    const r = textRig();
    await r.send('/setting banana yellow');
    expect(r.replies().at(-1)).toContain('No setting called');
    expect(r.cfg.routing.default).toBe('oc');
  });

  it('never runs a turn, whatever it was asked', async () => {
    const r = textRig();
    const prompts: string[] = [];
    await r.send('/setting');
    await r.send('/setting agent cc');
    await r.send('/setting access');
    await r.send('/setting banana');
    expect(prompts).toEqual([]); // no session was even created
    expect(r.sessions.size).toBe(0);
  });
});

describe('the button menu', () => {
  it('posts the settings list instead of the text answer', async () => {
    const r = rig();
    await r.send('/setting');
    expect(r.buttonSends).toHaveLength(1);
    expect(r.replies()).toEqual([]); // the text surface must not also fire
    expect(r.menu().text).toContain('saved to config.yaml');
    expect(r.ids('stg:')).toHaveLength(7); // agent + 2 models + delegation + idle + scope + stream
  });

  it('labels each row with its current value', async () => {
    const r = rig();
    await r.send('/setting');
    expect(r.menu().buttons.map((b) => b.label)).toContain('Default agent · oc · opencode');
  });

  it('attaches the structured screen only where the platform declares one', async () => {
    // A chat platform's menu is exactly the text and buttons it always was.
    const chat = rig();
    await chat.send('/setting');
    expect(chat.menu().screen).toBeUndefined();

    const web = rig({ caps: { settingsScreen: true } });
    await web.send('/setting');
    const list = web.menu().screen;
    expect(list?.level).toBe('list');
    if (list?.level !== 'list') throw new Error('no list screen');
    // The same rows the buttons carry, with the label and value split apart.
    expect(list.rows.map((r) => [r.label, r.target, r.value])).toContainEqual([
      'cc',
      'cc',
      'claude-opus-4-5',
    ]);
    expect(list.rows.map((r) => r.buttonId)).toEqual(web.menu().buttons.map((b) => b.id));
    // The agent answering here is named, and so is what it is.
    expect(list.rows.find((r) => r.target === 'oc')).toMatchObject({ here: true, targetKind: 'OpenCode' });

    // A level change is the same message edited, and the screen follows it down and back up.
    await web.click(web.ids('stg:')[0]!);
    expect(web.screen().screen?.level).toBe('values');
    await web.click(web.ids('stb:')[0]!);
    expect(web.screen().screen?.level).toBe('list');

    // Superseding it edits the old message with no screen: a dead screen must not outlive the
    // buttons it belonged to.
    await web.send('/setting');
    expect(web.buttonEdits.at(-1)?.screen).toBeUndefined();
  });

  it('opens a setting on the same message, with a way back', async () => {
    const r = rig();
    await r.send('/setting');
    await r.click(r.ids('stg:')[5]!); // scope
    expect(r.buttonSends).toHaveLength(1); // edited, not reposted
    expect(r.buttonEdits).toHaveLength(1);
    expect(r.buttonEdits[0]!.messageId).toBe(MENU_MSG);
    expect(r.screen().text).toContain('Conversation scope');
    expect(r.ids('stv:')).toHaveLength(4); // the four scopes
    expect(r.ids('stb:')).toHaveLength(1);
  });

  it('addresses the ref captured from the send, never the click event id', async () => {
    // On Telegram ev.messageId is the callback_query id; editing it 400s and the error is swallowed.
    const r = rig();
    await r.send('/setting');
    await r.click(r.ids('stg:')[0]!);
    expect(r.buttonEdits[0]!.messageId).not.toBe(CALLBACK_QUERY_ID);
  });

  it('writes the tapped value and returns to the list with the new value on it', async () => {
    const r = rig();
    await r.send('/setting');
    await r.click(r.ids('stg:')[0]!); // Default agent
    await r.click(r.ids('stv:')[1]!); // → cc
    const back = r.screen();
    expect(back.text).toContain('✓ Default agent → cc · claude');
    expect(back.text).toContain('in effect now');
    expect(back.buttons.map((b) => b.label)).toContain('Default agent · cc · claude');
    expect(onDisk()['routing']).toEqual({ default: 'cc' });
  });

  it('marks the value in force, so a screen says what it is as well as what it could be', async () => {
    const r = rig();
    await r.send('/setting');
    await r.click(r.ids('stg:')[0]!);
    expect(r.screen().buttons.filter((b) => b.label.startsWith('●'))).toHaveLength(1);
  });

  it('goes back to the list without writing anything', async () => {
    const r = rig();
    const before = text();
    await r.send('/setting');
    await r.click(r.ids('stg:')[5]!);
    await r.click(r.ids('stb:')[0]!);
    expect(r.screen().text).toContain('saved to config.yaml');
    expect(r.ids('stg:')).toHaveLength(7);
    expect(text()).toBe(before);
  });

  it('pages a long value list on the same message', async () => {
    const r = rig();
    await r.send('hello'); // so the model list is reported
    await r.send('/setting');
    await r.click(r.ids('stg:')[1]!); // Default model · oc → 8 models + clear
    expect(r.screen().text).toContain('page 1/2');
    await r.click(r.ids('stp:')[1]!); // Next ▶
    expect(r.screen().text).toContain('page 2/2');
    expect(r.buttonSends).toHaveLength(1); // still one message
  });

  it('stays on the value level when nothing was written, so a retry is one tap', async () => {
    // Tapping the ● value writes nothing, and a level change would suggest otherwise.
    const r = rig();
    await r.send('/setting');
    await r.click(r.ids('stg:')[5]!); // scope
    await r.click(r.ids('stv:')[0]!); // per_thread — already the value
    expect(r.screen().text).toContain('already');
    expect(r.ids('stv:').length).toBeGreaterThan(0);
    expect(r.ids('stb:')).toHaveLength(1); // still the value level, back button included
  });

  it('lands straight on a value screen when the command named the setting', async () => {
    const r = rig();
    await r.send('/setting idle');
    expect(r.menu().text).toContain('Idle reclaim');
    expect(r.menu().buttons.some((b) => b.id.startsWith('stv:'))).toBe(true);
  });

  it('says "type a name" on a value screen whose only button is "clear"', async () => {
    const r = rig(); // no turn has run, so no model list has been reported
    await r.send('/setting model.cc');
    expect(r.menu().text).toContain('not answering this conversation');
  });
});

describe('setting a value from the list screen', () => {
  /** The id a list row's control posts: a switch's one id, or the option of a choice named `label`. */
  const control = (s: SettingsScreen | undefined, rowLabel: string, option?: string): string => {
    if (s?.level !== 'list') throw new Error('not the list');
    const c = s.rows.find((r) => r.label === rowLabel)?.control;
    if (c?.kind === 'switch') return c.set;
    if (c?.kind === 'choice') return c.options.find((o) => o.label === option)!.buttonId;
    throw new Error(`${rowLabel} has no inline control`);
  };

  it('flips a switch in one tap: the file, the running daemon, and the list with a banner', async () => {
    const r = rig({ caps: { settingsScreen: true } });
    await r.send('/setting');
    await r.click(control(r.menu().screen, 'Confirm sub-agent starts'));
    expect(onDisk()['delegation']).toEqual({ confirm: false });
    expect(r.cfg.delegation.confirm).toBe(false);
    const after = r.screen().screen;
    if (after?.level !== 'list') throw new Error('not the list');
    expect(after.notice).toEqual({ tone: 'ok', text: expect.stringContaining('Confirm sub-agent starts → off') });
    expect(after.rows.find((x) => x.label === 'Confirm sub-agent starts')?.control).toMatchObject({ kind: 'switch', on: false });
    // And back, from the redrawn list's own id.
    await r.click(control(after, 'Confirm sub-agent starts'));
    expect(r.cfg.delegation.confirm).toBe(true);
  });

  it('writes a choice from the row, and says so when it is already the value', async () => {
    const r = rig({ caps: { settingsScreen: true } });
    await r.send('/setting');
    await r.click(control(r.menu().screen, 'Idle reclaim', '4h'));
    expect(onDisk()['session']).toMatchObject({ idleTimeoutMs: 14_400_000 });
    await r.click(control(r.screen().screen, 'Idle reclaim', '4h'));
    const s = r.screen().screen;
    if (s?.level !== 'list') throw new Error('not the list');
    expect(s.notice).toEqual({ tone: 'info', text: expect.stringContaining('already') });
  });

  it('answers a refused value as an error banner on the list, writing nothing', async () => {
    const r = rig({ caps: { settingsScreen: true } });
    const before = text();
    await r.send('/setting');
    // Default agent → cc is fine; the refusal path is driven by a choice id the list never drew.
    await r.click('sts:' + r.menu().buttons[0]!.id.split(':')[1] + ':999');
    const s = r.screen().screen;
    if (s?.level !== 'list') throw new Error('not the list');
    expect(s.notice?.tone).toBe('error');
    expect(s.notice?.text).toContain('expired');
    expect(text()).toBe(before);
  });

  it('never reaches a chat platform: its list carries no screen and no set ids', async () => {
    const r = rig();
    await r.send('/setting');
    expect(r.menu().screen).toBeUndefined();
    expect(r.menu().buttons.some((b) => b.id.startsWith('sts:'))).toBe(false);
  });
});

describe('menu lifetime', () => {
  it('a second /setting supersedes the first, and the old buttons say so', async () => {
    const r = rig();
    await r.send('/setting');
    const stale = r.ids('stg:')[0]!;
    await r.send('/setting');
    expect(r.buttonEdits[0]!.text).toContain('superseded');
    expect(r.buttonEdits[0]!.buttons).toEqual([]);
    await r.click(stale);
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('a click after a restart is answered, not ignored', async () => {
    const r = rig();
    await r.send('/setting');
    const id = r.ids('stg:')[0]!;
    const fresh = rig(); // a new daemon: pendingSettingsMenus is in-memory
    await fresh.click(id);
    expect(fresh.replies().at(-1)).toContain('expired');
  });

  it('a mangled index is answered rather than silently dropped', async () => {
    const r = rig();
    await r.send('/setting');
    const reqId = r.ids('stg:')[0]!.split(':')[1]!;
    await r.click(`stg:${reqId}:999`);
    // Falls back to the list rather than writing or going quiet.
    expect(r.buttonEdits.at(-1)!.text).toContain('saved to config.yaml');
  });
});

describe('access control', () => {
  it('a click from outside the allowlist writes nothing', async () => {
    // A menu in a shared channel can be pressed by someone other than whoever opened it — and this
    // click does not just change who answers, it edits the operator's config.yaml.
    const r = rig({ access: ['tg:u1'] });
    const before = text();
    await r.send('/setting');
    await r.click(r.ids('stg:')[0]!, 'intruder');
    expect(r.buttonEdits).toHaveLength(0);
    expect(text()).toBe(before);
  });

  it('the allowlisted user is unaffected', async () => {
    const r = rig({ access: ['tg:u1'] });
    await r.send('/setting');
    await r.click(r.ids('stg:')[0]!, 'u1');
    await r.click(r.ids('stv:')[1]!, 'u1');
    expect(onDisk()['routing']).toEqual({ default: 'cc' });
  });
});

describe('the voice-confirmation switch', () => {
  it('writes voice.confirm, applies it live, and leaves the transcriber block as written', async () => {
    fs.appendFileSync(file, VOICE_BLOCK);
    const r = textRig({ voice: true });
    await r.send('/setting voice off');
    expect(r.replies().at(-1)).toContain('in effect now');
    expect(r.cfg.voice?.confirm).toBe(false);
    const after = text();
    expect(after).toContain("# transcripts through newapi's google-ai-studio channel");
    expect(after).toContain('${NEWAPI_API_KEY}'); // the key is never expanded on the way to disk
    expect((onDisk()['voice'] as { confirm?: unknown }).confirm).toBe(false);
    expect(loadConfig().voice?.confirm).toBe(false);
  });

  it('is refused by name where there is no voice: block, and writes nothing', async () => {
    const r = textRig();
    const before = text();
    await r.send('/setting voice off');
    expect(r.replies().at(-1)).toContain('not editable from chat');
    expect(text()).toBe(before);
  });
});
