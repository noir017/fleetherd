import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { ScheduleStore } from './schedule-store.js';
import { parseConfig } from '../config/schema.js';
import { callDaemon } from '../ipc/client.js';
import type { IpcAction, ScheduleListResult, ScheduleTaskView } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * Scheduled tasks end to end: registered over the real socket the way an agent does it, then run
 * (`schedule run`, so no test waits on a clock) through the real registry and merger into stub
 * platforms. What is asserted is WHERE things land — the card, the notice, the output, the turn —
 * because every mode differs from the others exactly there.
 */

const parsed = parseConfig({
  // `dc` is configured but has no adapter in the rig: what a platform that failed to start
  // looks like to `schedule add`.
  platforms: { tg: { type: 'telegram', token: 't' }, web: { type: 'webui', token: 'w' }, dc: { type: 'discord', token: 'd' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'oc', harness: 'opencode' },
    // A harness with no model selector at all.
    { id: 'nosel', harness: 'opencode' },
    // A harness whose list only arrives once the session is up.
    { id: 'lazy', harness: 'opencode' },
  ],
  routing: { default: 'cc' },
});
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

type Sent = { platform: string; address: { channel: string; thread?: string }; text: string };
type Menu = { text: string; buttons: Array<{ id: string; label: string }> };

type Fake = PlatformAdapter & {
  threads: string[];
  /** Topic ids that still exist; a test removes one to stand in for the user deleting it. */
  alive: Set<string>;
  /** Topic ids a send to which fails, as a deleted topic does on a platform without hasThread. */
  dead: Set<string>;
  /** Make the next createThread calls fail, as a platform with every topic starred does. */
  failCreate(msg: string): void;
};

function adapter(
  id: string,
  type: string,
  sent: Sent[],
  opts: {
    thread: boolean;
    buttons?: boolean;
    menus?: Menu[];
    alive?: Set<string>;
    /** Default true; false is a platform whose topic is a message (Slack, Discord, Lark). */
    standaloneThread?: boolean;
    /** Default true; false is a platform with no way to say a topic was deleted. */
    hasThread?: boolean;
    /** A topic that comes back with an empty lane, as Slack's `thread_ts` does with no message. */
    emptyThread?: boolean;
  }
): Fake {
  const threads: string[] = [];
  const alive = opts.alive ?? new Set<string>();
  const dead = new Set<string>();
  const menus = opts.menus ?? [];
  let createError: string | undefined;
  return {
    platform: id,
    platformType: type,
    threads,
    alive,
    dead,
    failCreate: (msg: string) => {
      createError = msg;
    },
    capabilities: {
      thread: opts.thread,
      standaloneThread: opts.thread && (opts.standaloneThread ?? true),
      editMessage: true,
      buttons: opts.buttons ?? false,
      editButtons: opts.buttons ?? false,
      reaction: false,
      reply: false,
      typing: false,
      maxMessageLength: 4096,
    },
    sendButtons: async (address: Sent['address'], text: string, buttons: Menu['buttons']) => {
      menus.push({ text, buttons });
      return { address, messageId: 'menu' };
    },
    editButtons: async (_ref: unknown, text: string, buttons: Menu['buttons']) => void menus.push({ text, buttons }),
    sendMessage: async (address: Sent['address'], text: string) => {
      if (address.thread !== undefined && dead.has(address.thread)) throw new Error('no such topic');
      sent.push({ platform: id, address, text });
      return { address, messageId: `${id}-${sent.length}` };
    },
    sendFile: async (address: Sent['address'], file: { name?: string }) => {
      sent.push({ platform: id, address, text: `[file ${file.name}]` });
      return { address, messageId: 'f' };
    },
    ...(opts.hasThread === false
      ? {}
      : { hasThread: (address: Sent['address']) => address.thread !== undefined && alive.has(address.thread) }),
    createThread: async (ref: { address: { channel: string } }, name: string) => {
      if (createError) throw new Error(createError);
      if (opts.emptyThread) return { address: { channel: ref.address.channel, thread: '' } };
      threads.push(name);
      const thread = `new${threads.length}`;
      alive.add(thread);
      return { address: { channel: ref.address.channel, thread } };
    },
    renameThread: async () => {},
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
    stop: async () => {},
  } as unknown as Fake;
}

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A daemon on `dir`; passing the previous rig's dir restarts it against the same state files. */
async function rig(
  existing?: string,
  alive?: Set<string>,
  over: { standaloneThread?: boolean; hasThread?: boolean; emptyThread?: boolean; perUser?: boolean; holdProbe?: boolean } = {}
) {
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aa-schedule-'));
  if (!dirs.includes(dir)) dirs.push(dir);
  const socket = path.join(dir, 'd.sock');
  const sent: Sent[] = [];
  const tokens: string[] = [];
  const turns: Array<{ conversation: string; agent: string; prompt: string }> = [];
  const models: Array<{ conversation: string; model: string }> = [];
  const ensured: string[] = [];
  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  // A gate `lazy`'s ensureSession waits on, so a test can overlap two `schedule add --model`s.
  let openProbe: () => void = () => {};
  const probeGate = new Promise<void>((resolve) => {
    openProbe = resolve;
  });
  const agents: AgentFactory = {
    getOrCreate(conversationId, agentId) {
      let s = sessions.get(conversationId);
      if (!s) {
        // `lazy` has no list until something brings the session up, as ACP's session/new does.
        let warm = agentId !== 'lazy';
        s = {
          conversationId,
          runTurn: async (input: { prompt: string; sessionToken: string }) => {
            tokens.push(input.sessionToken);
            turns.push({ conversation: conversationId, agent: agentId, prompt: input.prompt });
          },
          ...(agentId === 'nosel'
            ? {}
            : {
                modelSelector: () =>
                  warm
                    ? {
                        current: 'base-model',
                        options: ['base-model', 'fast-model', 'runtime-fail'].map((value) => ({ value, name: value })),
                      }
                    : undefined,
              }),
          ensureSession: async () => {
            ensured.push(conversationId);
            if (agentId === 'lazy' && over.holdProbe) await probeGate;
            warm = true;
          },
          setModel: async (value: string) => {
            if (value === 'runtime-fail') throw new Error('the harness refused this model');
            models.push({ conversation: conversationId, model: value });
            return value;
          },
          abort: () => {},
          dispose: () => {},
        } as unknown as AgentSession;
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
  const tg = adapter('tg', 'telegram', sent, { thread: false });
  const menus: Menu[] = [];
  const web = adapter('web', 'webui', sent, { thread: true, buttons: true, menus, ...(alive ? { alive } : {}), ...over });
  const daemon = new Daemon(
    // `per_user` keys every conversation by its sender, so a new topic has no conversation of
    // its own to map to — the scope a daily run must be refused under before it opens one.
    over.perUser ? { ...cfg, session: { ...cfg.session, scope: 'per_user' as const } } : cfg,
    new Map<string, PlatformAdapter>([
      ['tg', tg],
      ['web', web],
    ]),
    agents,
    socket,
    new ConversationStore(path.join(dir, 'conversations.json')),
    undefined,
    { store: new ScheduleStore(path.join(dir, 'schedules.json')), runsDir: path.join(dir, 'runs') }
  );
  daemons.push(daemon);
  const internals = daemon as unknown as {
    ipc: { start(): Promise<void> };
    schedules: { scheduler: { start(): void }; targets(ref: InboundMessage['conversation']): boolean };
  };
  await internals.ipc.start();
  internals.schedules.scheduler.start();

  let n = 0;
  const inbound = async (conversation: InboundMessage['conversation'], content: string): Promise<void> => {
    (daemon as unknown as { onInbound: (m: InboundMessage) => void }).onInbound({ conversation, messageId: `in_${++n}`, content, timestamp: Date.now() });
    await settle();
  };
  const call = async (action: IpcAction) => callDaemon(socket, action, tokens[0]!);
  /** Tap a button on the last menu by its label. */
  const tap = async (label: string | RegExp): Promise<void> => {
    const menu = menus.at(-1)!;
    const button = menu.buttons.find((b) => (typeof label === 'string' ? b.label === label : label.test(b.label)));
    if (!button) throw new Error(`no button ${label} on: ${menu.buttons.map((b) => b.label).join(' | ')}`);
    (daemon as unknown as { onButton: (ev: unknown) => void }).onButton({ buttonId: button.id, conversation: WEB, messageId: 'menu' });
    await settle(20);
  };
  /** What the web UI asks before evicting a topic (`PlatformAdapter.useScheduleLookup`). */
  const targets = (ref: InboundMessage['conversation']): boolean => internals.schedules.targets(ref);
  /** Stop this daemon (a restart is another rig() on the same dir). */
  const stop = async (): Promise<void> => {
    await daemon.stop();
    const i = daemons.indexOf(daemon);
    if (i >= 0) daemons.splice(i, 1);
  };
  return { dir, sent, turns, models, ensured, disposed, tg, web, menus, inbound, call, tap, targets, stop, openProbe };
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WEB = { platform: 'web', channel: 'main', thread: 't1', kind: 'direct' as const, user: 'u1' };

async function added(r: Awaited<ReturnType<typeof rig>>, action: Extract<IpcAction, { kind: 'schedule-add' }>): Promise<ScheduleTaskView> {
  const resp = await r.call(action);
  if (!resp.ok) throw new Error(resp.error);
  return (resp.data as { task: ScheduleTaskView }).task;
}

describe('schedule over IPC', () => {
  it('registers a task and posts the gateway\'s own card where the user is talking', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    r.sent.length = 0;
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'morning brief', session: 'new', name: 'brief' });
    expect(task).toMatchObject({ name: 'brief', state: 'active', runs: 'cc · new session each run', target: 'web:main/t1', prompt: 'morning brief' });
    await settle();
    const card = r.sent.find((s) => s.text.includes('Scheduled task registered'))!;
    expect(card.address).toEqual({ channel: 'main', thread: 't1' });
    expect(card.text).toContain(`#${task.id}`);
    expect(fs.existsSync(path.join(r.dir, 'schedules.json'))).toBe(true);
  });

  it('refuses a fixed-session task for another agent, with the way out', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const resp = await r.call({ kind: 'schedule-add', cron: '*/30 * * * *', prompt: 'x', agent: 'oc' });
    expect(resp.ok).toBe(false);
    expect((resp as { error: string }).error).toMatch(/answered by cc.*--session new to run oc/);
  });

  it('bash: runs the command and posts exit code and output to the target', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', at: '+1h', bash: 'echo scheduled-hello', channelId: 'tg:586' });
    expect(task.target).toBe('tg:586');
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle(400);
    const result = r.sent.find((s) => s.platform === 'tg')!;
    expect(result.address).toEqual({ channel: '586' });
    expect(result.text).toMatch(/✅ exit 0/);
    expect(result.text).toContain('scheduled-hello');
    expect(r.turns).toHaveLength(1); // only the user's own turn; no agent was involved
  });

  it('fixed session: the prompt is a turn in the registering conversation, after a notice', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '*/30 * * * *', prompt: 'check the build' });
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#t1', agent: 'cc' });
    // The prompt reaches the agent exactly as registered; only the user's notice says it was scheduled.
    expect(r.turns.at(-1)!.prompt).toBe('check the build');
    expect(r.sent[0]!.text).toMatch(/⏰ Scheduled task `#\w+` \*\*check the build\*\*/);
  });

  it('new session: a fresh topic per run where the platform can open one', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toEqual([expect.stringMatching(/^\[oc\] ⏰ brief · /)]);
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#new1', agent: 'oc' });
    // The conversation is kept: the user can carry on in the new topic.
    expect(r.disposed).not.toContain('web#main#new1');
  });

  it('new session on a platform with no threads: posted into the chat, then forgotten', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', channelId: 'tg:586' });
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const turn = r.turns.at(-1)!;
    expect(turn.conversation).toMatch(new RegExp(`^schedule#${task.id}#`));
    expect(r.sent[0]).toMatchObject({ platform: 'tg', address: { channel: '586' } });
    expect(r.disposed).toContain(turn.conversation);
  });

  it('daily: two runs the same day share one topic, titled with the date', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const first = r.turns.at(-1)!;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toHaveLength(1);
    expect(r.web.threads[0]).toMatch(/^\[cc\] ⏰ brief · \d{4}-\d{2}-\d{2}$/);
    const briefs = r.turns.filter((t) => t.prompt === 'brief');
    expect(briefs).toHaveLength(2);
    expect(briefs[1]!.conversation).toBe(first.conversation);
    expect(r.disposed).not.toContain(first.conversation);
    // The day's topic is protected from eviction too: it is not the task's target, and losing it
    // mid-day would drop the context the day's runs have been building.
    expect(r.targets({ ...WEB, thread: 'new1' })).toBe(true);
  });

  it('daily: a restart mid-day rejoins the same topic', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const key = r.turns.at(-1)!.conversation;
    await r.stop();

    const again = await rig(r.dir, r.web.alive);
    await again.inbound(WEB, 'hello');
    await again.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(again.web.threads).toHaveLength(0);
    expect(again.turns.at(-1)).toMatchObject({ conversation: key, prompt: 'brief' });
  });

  it('daily: a topic deleted during the day is reopened on the next run', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const first = r.turns.at(-1)!.conversation;
    r.web.alive.delete(first.split('#').at(-1)!);
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toHaveLength(2);
    expect(r.turns.at(-1)!.conversation).not.toBe(first);
  });

  it('daily: a topic that cannot be opened fails the run and says so in the chat', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    r.web.failCreate('every topic is starred');
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.turns.filter((t) => t.prompt === 'brief')).toHaveLength(0);
    expect(r.sent.find((s) => s.text.includes('could not open a topic for today\'s session: every topic is starred'))).toBeDefined();
    const list = await r.call({ kind: 'schedule-list', id: task.id });
    expect((list as { data: { tasks: ScheduleTaskView[] } }).data.tasks[0]!.last).toMatch(/^failed /);
  });

  it('refuses daily where it cannot work, each time with the reason', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const noTopic = await r.call({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'x', session: 'daily', channelId: 'tg:586' });
    expect(noTopic).toMatchObject({ ok: false });
    expect((noTopic as { error: string }).error).toMatch(/needs a target that can open a topic with no message/);
    const oneShot = await r.call({ kind: 'schedule-add', at: '+1h', prompt: 'x', session: 'daily' });
    expect((oneShot as { error: string }).error).toMatch(/needs --cron/);
    const bash = await r.call({ kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', session: 'daily' });
    expect((bash as { error: string }).error).toMatch(/--session daily is for --prompt tasks/);
  });

  it('refuses daily where a topic needs a message, and still lets new fall back to the chat', async () => {
    // A platform that has threads but cannot open one without a message (Slack, Discord, Lark).
    const r = await rig(undefined, undefined, { standaloneThread: false });
    await r.inbound(WEB, 'hello');
    const daily = await r.call({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'x', session: 'daily' });
    expect((daily as { error: string }).error).toMatch(/needs a target that can open a topic with no message/);
    const fresh = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'x', session: 'new' });
    expect(fresh.runs).toBe('cc · new session each run');
  });

  it('names a platform that is not running as such, not as one that cannot open a topic', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    // `dc` is configured but has no adapter here, as after a platform failed to start.
    const resp = await r.call({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'x', session: 'new', channelId: 'dc:123' });
    expect((resp as { error: string }).error).toMatch(/platform instance "dc" is not running/);
  });

  it('a topic that comes back with no thread fails the daily run instead of storing an empty one', async () => {
    // Slack answers createThread with the messageId it was given; a scheduled run has none.
    const r = await rig(undefined, undefined, { emptyThread: true });
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.turns.filter((t) => t.prompt === 'brief')).toHaveLength(0);
    expect(r.sent[0]!.text).toMatch(/could not open a topic for today's session: .*did not open a topic/);
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'schedules.json'), 'utf8')) as {
      tasks: Array<{ daySession?: unknown }>;
    };
    expect(saved.tasks[0]!.daySession).toBeUndefined();
  });

  it('a per-user deployment refuses a daily run before opening a topic it cannot own', async () => {
    const r = await rig(undefined, undefined, { perUser: true });
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    // Nothing was created: the refusal is checked before createThread, or every run would leak
    // a topic that no conversation maps to.
    expect(r.web.threads).toHaveLength(0);
    expect(r.sent[0]!.text).toMatch(/does not map to a conversation of its own/);
  });

  it('a daily topic that is gone on a platform without hasThread is reopened on the next run', async () => {
    const r = await rig(undefined, undefined, { hasThread: false });
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const first = r.turns.at(-1)!.conversation;
    r.web.dead.add('new1');
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.turns.filter((t) => t.prompt === 'brief')).toHaveLength(1); // the failed run made no turn
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'schedules.json'), 'utf8')) as {
      tasks: Array<{ daySession?: unknown }>;
    };
    expect(saved.tasks[0]!.daySession).toBeUndefined();
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toHaveLength(2);
    expect(r.turns.at(-1)!.conversation).not.toBe(first);
  });

  it('reports a daily run that keeps failing for the same reason once, not every run', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '*/5 * * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    r.web.failCreate('every topic is starred');
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.sent.filter((s) => s.text.includes('could not open a topic')).length).toBe(1);
  });

  it('a new-session task names its model on the card and applies it before the turn', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', model: 'fast-model', name: 'brief' });
    expect(task.runs).toBe('cc · fast-model · new session each run');
    expect(r.sent.at(-1)!.text).toContain('cc · fast-model · new session each run');
    // The caller's own agent is read there; no throwaway session is started for it.
    expect(r.disposed.some((id) => id.startsWith('__schedule-model__#cc#'))).toBe(false);
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.models).toEqual([{ conversation: 'web#main#new1', model: 'fast-model' }]);
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#new1', prompt: 'brief' });
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'schedules.json'), 'utf8')) as {
      tasks: Array<{ run: { model?: string } }>;
    };
    expect(saved.tasks[0]!.run.model).toBe('fast-model');
  });

  it('refuses a model the agent does not offer, naming the ones it does', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const resp = await r.call({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', model: 'nope' });
    expect(resp).toMatchObject({ ok: false });
    expect((resp as { error: string }).error).toMatch(/unknown model "nope" for agent "cc"; choose one of: base-model, fast-model, runtime-fail/);
    expect((await r.call({ kind: 'schedule-list' }) as { data: ScheduleListResult }).data.tasks).toEqual([]);
  });

  it('asks another agent for its own list in a throwaway session, then disposes it', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', model: 'fast-model' });
    expect(task.runs).toBe('oc · fast-model · new session each run');
    expect(r.disposed.some((id) => id.startsWith('__schedule-model__#oc#'))).toBe(true);
    expect(r.turns).toHaveLength(1); // only the user's own hello; no work in the throwaway session
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.models).toEqual([{ conversation: 'web#main#new1', model: 'fast-model' }]);
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#new1', agent: 'oc' });
  });

  it('brings a session up to read the list when the agent has none yet, and disposes it', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'lazy', model: 'fast-model' });
    expect(task.runs).toBe('lazy · fast-model · new session each run');
    expect(r.ensured.some((id) => id.startsWith('__schedule-model__#lazy#'))).toBe(true);
    expect(r.disposed.some((id) => id.startsWith('__schedule-model__#lazy#'))).toBe(true);
  });

  it('two adds for the same agent do not share the throwaway session', async () => {
    const r = await rig(undefined, undefined, { holdProbe: true });
    await r.inbound(WEB, 'hello');
    const one = r.call({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'a', session: 'new', agent: 'lazy', model: 'fast-model' });
    const two = r.call({ kind: 'schedule-add', cron: '0 9 * * *', prompt: 'b', session: 'new', agent: 'lazy', model: 'fast-model' });
    await settle(); // both are inside ensureSession, waiting on the gate
    r.openProbe();
    expect((await one).ok).toBe(true);
    expect((await two).ok).toBe(true);
    // A shared key would make the first call's cleanup dispose the session the second is using.
    const keys = r.ensured.filter((id) => id.startsWith('__schedule-model__#lazy#'));
    expect(new Set(keys).size).toBe(2);
    expect(r.disposed.filter((id) => id.startsWith('__schedule-model__#lazy#'))).toHaveLength(2);
  });

  it('refuses --model when the agent has no model selector, and on a fixed-session task', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const none = await r.call({ kind: 'schedule-add', cron: '0 8 * * *', prompt: 'x', session: 'new', agent: 'nosel', model: 'fast-model' });
    expect((none as { error: string }).error).toMatch(/has no model list.*drop --model/);
    const fixed = await r.call({ kind: 'schedule-add', cron: '0 * * * *', prompt: 'x', model: 'fast-model' });
    expect((fixed as { error: string }).error).toMatch(/fixed-session.*--session new or --session daily/);
    const bash = await r.call({ kind: 'schedule-add', cron: '0 3 * * *', bash: 'ls', model: 'fast-model' });
    expect((bash as { error: string }).error).toMatch(/--model is for --prompt tasks/);
  });

  it('a model the harness refuses fails the run and says so, with no turn', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', model: 'runtime-fail', name: 'brief' });
    const before = r.turns.length;
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.turns).toHaveLength(before);
    // The failure replaces the run notice: the run never announced itself as started.
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).toContain('failed — could not set model "runtime-fail": the harness refused this model');
    const list = await r.call({ kind: 'schedule-list', id: task.id });
    expect((list as { data: { tasks: ScheduleTaskView[] } }).data.tasks[0]!.last).toMatch(/^failed /);
  });

  it('daily: applies its model on the first run and leaves a person\'s /model alone after', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', model: 'fast-model', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.models).toEqual([{ conversation: 'web#main#new1', model: 'fast-model' }]);

    await r.inbound({ ...WEB, thread: 'new1' }, '/model base-model');
    expect(r.models.at(-1)).toEqual({ conversation: 'web#main#new1', model: 'base-model' });

    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.models).toHaveLength(2); // the person's choice stands; the task does not put its own back
    expect(r.turns.filter((t) => t.prompt === 'brief')).toHaveLength(2);
  });

  it('daily: a person\'s /model still wins after a restart', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', model: 'fast-model', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.models).toEqual([{ conversation: 'web#main#new1', model: 'fast-model' }]);
    await r.inbound({ ...WEB, thread: 'new1' }, '/model base-model');
    await r.stop();

    const again = await rig(r.dir, r.web.alive);
    await again.inbound(WEB, 'hello');
    await again.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    // The in-memory override is gone, but the task remembered the topic was set by hand and
    // leaves its model alone instead of putting its own back.
    expect(again.models).toEqual([]);
    expect(again.turns.at(-1)).toMatchObject({ conversation: 'web#main#new1', prompt: 'brief' });
  });

  it('says which conversations a task can still post into, so the web UI will not evict them', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '*/30 * * * *', prompt: 'check the build' });
    expect(r.targets(WEB)).toBe(true);
    expect(r.targets({ ...WEB, thread: 't2' })).toBe(false);
    expect(r.targets({ ...WEB, platform: 'tg' })).toBe(false);
    // Paused still counts: resuming it must find its topic where it was left.
    await r.call({ kind: 'schedule-op', id: task.id, op: 'pause' });
    expect(r.targets(WEB)).toBe(true);
    await r.call({ kind: 'schedule-op', id: task.id, op: 'remove' });
    expect(r.targets(WEB)).toBe(false);
  });

  it('list, pause and rm answer with the task and post a card for each change', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true' });
    const list = await r.call({ kind: 'schedule-list' });
    expect((list as { data: ScheduleListResult }).data.tasks).toEqual([expect.objectContaining({ id: task.id, here: true })]);

    r.sent.length = 0;
    const paused = await r.call({ kind: 'schedule-op', id: task.id, op: 'pause' });
    expect((paused as { data: { task: ScheduleTaskView } }).data.task.state).toBe('paused');
    await r.call({ kind: 'schedule-op', id: task.id, op: 'remove' });
    await settle();
    expect(r.sent.map((s) => s.text.split(' — ')[0])).toEqual(['⏰ Scheduled task paused', '⏰ Scheduled task deleted']);
    const gone = await r.call({ kind: 'schedule-op', id: task.id, op: 'pause' });
    expect(gone).toMatchObject({ ok: false, error: `no scheduled task #${task.id}` });
  });
});

/**
 * `schedule edit`: the same task, some fields changed. What is asserted is what a delete-and-add
 * would have lost (the id and the history), and that a refusal writes nothing at all.
 */
describe('schedule edit over IPC', () => {
  const saved = (r: Awaited<ReturnType<typeof rig>>): Array<Record<string, unknown>> =>
    (JSON.parse(fs.readFileSync(path.join(r.dir, 'schedules.json'), 'utf8')) as { tasks: Array<Record<string, unknown>> }).tasks;

  it('changes only the fields given, keeps the id and history, and posts the updated card', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'morning brief', session: 'new', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();

    r.sent.length = 0;
    const resp = await r.call({ kind: 'schedule-edit', id: task.id, agent: 'oc', prompt: 'evening brief' });
    expect(resp.ok).toBe(true);
    const after = (resp as { data: { task: ScheduleTaskView } }).data.task;
    expect(after).toMatchObject({ id: task.id, name: 'brief', runs: 'oc · new session each run', prompt: 'evening brief', count: 1 });
    expect(after.last).toMatch(/^ok /); // the run before the edit is still the task's last

    await settle();
    const card = r.sent.find((s) => s.text.includes('Scheduled task updated'))!;
    expect(card.text).toContain(`#${task.id}`);
    expect(card.text).toContain('oc · new session each run');
    expect(card.text).toContain('evening brief');

    const [stored] = saved(r);
    expect(stored).toMatchObject({ id: task.id, name: 'brief', runs: 1, run: { agent: 'oc', prompt: 'evening brief', session: 'new' } });
  });

  it('refuses an invalid change and leaves the task exactly as it was', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'cc', name: 'brief' });
    const before = JSON.stringify(saved(r));

    const unknownAgent = await r.call({ kind: 'schedule-edit', id: task.id, agent: 'zz' });
    expect((unknownAgent as { error: string }).error).toMatch(/unknown agent "zz"/);
    const unknownModel = await r.call({ kind: 'schedule-edit', id: task.id, model: 'nope' });
    expect((unknownModel as { error: string }).error).toMatch(/unknown model "nope" for agent "cc"; choose one of: base-model, fast-model, runtime-fail/);
    const badCron = await r.call({ kind: 'schedule-edit', id: task.id, cron: '0 8 * * * *' });
    expect((badCron as { error: string }).error).toMatch(/not a 5-field cron/);

    expect(JSON.stringify(saved(r))).toBe(before);
  });

  it('recomputes the next run from the edit under the new time rule', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', at: '+1h', prompt: 'brief', session: 'new' });
    const resp = await r.call({ kind: 'schedule-edit', id: task.id, at: '+2h' });
    const after = (resp as { data: { task: ScheduleTaskView } }).data.task;
    expect(after.next).not.toBe(task.next);
    expect(Date.parse(after.next.replace(' ', 'T'))).toBeGreaterThan(Date.parse(task.next.replace(' ', 'T')));
  });

  it('a daily task whose agent changes opens a new topic for the rest of the day', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const first = r.turns.at(-1)!.conversation;

    await r.call({ kind: 'schedule-edit', id: task.id, agent: 'oc' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toHaveLength(2);
    expect(r.web.threads[1]).toMatch(/^\[oc\] ⏰ brief · \d{4}-\d{2}-\d{2}$/);
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#new2', agent: 'oc' });
    expect(r.turns.at(-1)!.conversation).not.toBe(first);
  });

  it('a daily task that only changes its name keeps today\'s topic', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'daily', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const first = r.turns.at(-1)!.conversation;

    await r.call({ kind: 'schedule-edit', id: task.id, name: 'the brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toHaveLength(1);
    expect(r.turns.at(-1)!.conversation).toBe(first);
  });

  it('refuses while a run of that task is in flight', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'sleep 1' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    const resp = await r.call({ kind: 'schedule-edit', id: task.id, name: 'renamed' });
    expect(resp).toMatchObject({ ok: false, error: `#${task.id} is running right now; edit it once that run finishes` });
    await settle(1_200);
  });
});

/**
 * `/setting` → ⏰ Scheduled tasks. One message throughout: the entry button hands the settings menu
 * over, and every level after is an edit of it. Deleting takes two taps.
 */
describe('scheduled tasks under /setting', () => {
  const TG_DM = { platform: 'tg', channel: '586', kind: 'direct' as const, user: 'u1' };

  it('lists, pauses and deletes from the menu, then goes back to the settings', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', name: 'backup' });
    await r.inbound(WEB, '/setting');
    expect(r.menus.at(-1)!.buttons.at(-1)!.label).toBe('⏰ Scheduled tasks · 1 active');

    await r.tap(/^⏰ Scheduled tasks/);
    expect(r.menus.at(-1)!.text).toContain('backup');
    await r.tap(`#${task.id} backup`);
    expect(r.menus.at(-1)!.text).toContain('`0 8 * * *` (');
    r.sent.length = 0;

    await r.tap('⏸ Pause');
    expect(r.menus.at(-1)!.text).toMatch(/^⏸ Paused `#\w+` \*\*backup\*\*\./);
    expect(r.menus.at(-1)!.buttons.map((b) => b.label)).toEqual(['▶ Resume', '🗑 Delete', '◀ Back']);
    expect(r.sent).toEqual([]); // the menu is the answer; no second card beside it

    await r.tap('🗑 Delete');
    expect(r.menus.at(-1)!.text).toMatch(/^Delete `#\w+` \*\*backup\*\*\?/);
    await r.tap('🗑 Yes, delete it');
    expect(r.menus.at(-1)!.text).toMatch(/^🗑 Deleted `#\w+` \*\*backup\*\*\.\n\nNo scheduled tasks/);
    const list = await r.call({ kind: 'schedule-list' });
    expect((list as { data: ScheduleListResult }).data.tasks).toEqual([]);

    await r.tap('◀ Settings');
    expect(r.menus.at(-1)!.text).toMatch(/^Settings — /);
  });

  it('cancel on the confirmation goes back to the task without deleting it', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', name: 'keep' });
    await r.inbound(WEB, '/setting schedule');
    await r.tap(`#${task.id} keep`);
    await r.tap('🗑 Delete');
    await r.tap('Cancel');
    expect(r.menus.at(-1)!.buttons.map((b) => b.label)).toContain('⏸ Pause');
    expect((await r.call({ kind: 'schedule-list' }) as { data: ScheduleListResult }).data.tasks).toHaveLength(1);
  });

  it('works by typing where there are no buttons, answering with the task card', async () => {
    const r = await rig();
    await r.inbound(TG_DM, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', name: 'typed' });
    r.sent.length = 0;
    await r.inbound(TG_DM, '/setting schedule');
    expect(r.sent.at(-1)!.text).toMatch(/\*\*Scheduled tasks\*\*\n`#\w+` \*\*typed\*\*/);
    await r.inbound(TG_DM, `/setting schedule pause ${task.id}`);
    expect(r.sent.at(-1)!.text).toMatch(/^⏰ Scheduled task paused — `#\w+` \*\*typed\*\*/);
    await r.inbound(TG_DM, '/setting');
    expect(r.sent.at(-1)!.text).toContain('⏰ `/setting schedule` — 1 scheduled task(s)');
  });
});
