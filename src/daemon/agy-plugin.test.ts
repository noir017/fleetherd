import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import { EXPERIENCE } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import { TOOL_SILENCE_FACTOR } from './agent-acp.js';
import { AGY_PLUGIN_NAME, AGY_WAIT_WINDOW_S, agyPluginHome, agyPluginSource, ensureAgyPlugin } from './agy-plugin.js';
import { RemoteHosts } from './remote-hosts.js';
import { linkSkill } from './skill-link.js';

/**
 * The plugin is three files the daemon cannot type-check — JSON agy reads and a shell script it runs
 * — so this pins what they promise: the package carries them, the hook outlives its own wait and the
 * wait stays inside the gateway's watchdog, and the script decides as agy-plugin.ts says, against
 * the mailbox layout captured from agy 1.5.8.
 */

const source = agyPluginSource();
const script = path.join(source, 'wait-background.sh');

describe('the plugin as shipped', () => {
  it('is a plugin agy will load, with the Stop hook pointing at the script beside it', () => {
    expect(JSON.parse(fs.readFileSync(path.join(source, 'plugin.json'), 'utf8'))).toEqual({ name: AGY_PLUGIN_NAME });
    const hooks = JSON.parse(fs.readFileSync(path.join(source, 'hooks.json'), 'utf8')) as Record<string, { Stop: Array<{ command: string; timeout: number }> }>;
    const stop = Object.values(hooks).flatMap((h) => h.Stop);
    expect(stop).toHaveLength(1);
    // agy runs a plugin's hook from the plugin's directory, so the path is relative to it.
    expect(stop[0]!.command).toBe('sh ./wait-background.sh');
    expect(fs.existsSync(script)).toBe(true);
  });

  it('waits less than the watchdog allows a quiet turn, and agy waits longer than the hook does', () => {
    const scriptWindow = Number(/window=\$\{FLEETHERD_AGY_WAIT_WINDOW_S:-(\d+)\}/.exec(fs.readFileSync(script, 'utf8'))?.[1]);
    expect(scriptWindow).toBe(AGY_WAIT_WINDOW_S);
    // The background command keeps a tool call open, so the turn may be quiet for the full ceiling;
    // the model's turn after the window has to start before it, with room for a slow first token.
    const ceilingS = (EXPERIENCE.session.turnTimeoutMs * (1 + TOOL_SILENCE_FACTOR)) / 1000;
    expect(AGY_WAIT_WINDOW_S).toBeLessThanOrEqual(ceilingS - 5 * 60);
    // A hook that times out ends the turn: the hook must give its answer first.
    const hooks = JSON.parse(fs.readFileSync(path.join(source, 'hooks.json'), 'utf8')) as Record<string, { Stop: Array<{ timeout: number }> }>;
    const timeout = Object.values(hooks)[0]!.Stop[0]!.timeout;
    expect(timeout).toBeGreaterThan(AGY_WAIT_WINDOW_S + 30);
  });
});

describe('where it goes', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is for agy alone, in the plugins directory beside the skills', () => {
    expect(agyPluginHome('agy', '/h')).toEqual({ dir: '/h/.gemini/config/plugins', requires: '/h/.gemini/antigravity-cli' });
    for (const harness of ['claude', 'codex', 'opencode', 'gemini', 'dsh', 'custom'] as const) {
      expect(agyPluginHome(harness, '/h')).toBeUndefined();
    }
  });

  it('is linked only where agy has run, as the skills are', () => {
    const where = agyPluginHome('agy', home)!;
    expect(linkSkill(source, where, AGY_PLUGIN_NAME).outcome).toBe('skipped');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    expect(linkSkill(source, where, AGY_PLUGIN_NAME).outcome).toBe('linked');
    expect(fs.readlinkSync(path.join(home, '.gemini', 'config', 'plugins', 'fleetherd'))).toBe(source);
  });

  it('does nothing from a test worker, which is not the CLI', () => {
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    expect(ensureAgyPlugin('agy', home)).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.gemini', 'config', 'plugins'))).toBe(false);
  });
});

describe('RemoteHosts.placeAgyPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function fakeHost() {
    return {
      id: 'box',
      writeFile: vi.fn(async () => {}),
      sweepSkillLinks: vi.fn(async () => [] as string[]),
      ensureLink: vi.fn(async (_t: string, link: string) => ({ outcome: 'linked', link })),
    };
  }
  const agy = { id: 'ag', harness: 'agy', env: {} } as unknown as AgentDef;
  const welcome = { instance: 'i1', home: '/home/u', version: '9.9.9' } as unknown as Welcome;

  it('copies the files into the version directory once, and links them at every spawn', async () => {
    const hosts = new RemoteHosts();
    const host = fakeHost();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await hosts.placeAgyPlugin(host as unknown as RemoteHost, agy, '/home/u', welcome);
    await hosts.placeAgyPlugin(host as unknown as RemoteHost, agy, '/home/u', welcome);
    const written = host.writeFile.mock.calls.map((c) => (c as unknown[])[0]);
    expect(written.sort()).toEqual(
      ['hooks.json', 'plugin.json', 'wait-background.sh'].map((f) => `/home/u/.fleetherd/remote/9.9.9/agy-plugin/${f}`)
    );
    expect(host.sweepSkillLinks).toHaveBeenCalledTimes(1);
    expect(host.sweepSkillLinks).toHaveBeenCalledWith('/home/u/.gemini/config/plugins');
    expect(host.ensureLink).toHaveBeenCalledTimes(2);
    expect(host.ensureLink).toHaveBeenCalledWith(
      '/home/u/.fleetherd/remote/9.9.9/agy-plugin',
      '/home/u/.gemini/config/plugins/fleetherd',
      '/home/u/.gemini/antigravity-cli'
    );
  });

  it('places nothing for any other harness', async () => {
    const hosts = new RemoteHosts();
    const host = fakeHost();
    await hosts.placeAgyPlugin(host as unknown as RemoteHost, { ...agy, harness: 'claude' } as AgentDef, '/home/u', welcome);
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(host.ensureLink).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('wait-background.sh', () => {
  let dir: string;
  let box: string;
  const conv = 'c0ffee00-1111-2222-3333-444455556666';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wait-'));
    box = path.join(dir, 'brain', conv, '.system_generated', 'messages');
    fs.mkdirSync(box, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A message as agy 1.5.8 writes one: a task finishing is high priority, a restart notice low. */
  function message(id: string, priority = 'MESSAGE_PRIORITY_HIGH'): void {
    fs.writeFileSync(
      path.join(box, `${id}.json`),
      JSON.stringify({ id, recipient: conv, sender: `${conv}/task-3`, priority, content: 'Task id "…/task-3" finished with result: …' })
    );
  }
  function markRead(...ids: string[]): void {
    fs.writeFileSync(path.join(box, 'read.json'), JSON.stringify(Object.fromEntries(ids.map((id) => [id, true]))));
  }
  function payload(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      conversationId: conv,
      transcriptPath: path.join(dir, 'brain', conv, '.system_generated', 'logs', 'transcript_full.jsonl'),
      hookEventName: 'Stop',
      executionNum: 0,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: false,
      ...over,
    });
  }

  /** Run the hook as agy would; resolves with its answer and how long it took. */
  function run(input: string, env: Record<string, string | undefined> = {}): Promise<{ out: unknown; ms: number }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('sh', [script], {
        cwd: source,
        env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, FLEETHERD_TURN_TOKEN: 't', FLEETHERD_AGY_WAIT_WINDOW_S: '20', ...env },
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve({ out: JSON.parse(out), ms: Date.now() - started });
        } catch (e) {
          reject(new Error(`not JSON: ${JSON.stringify(out)} (${e instanceof Error ? e.message : e})`));
        }
      });
      child.stdin.on('error', () => {}); // a hook that answers without reading is its business
      child.stdin.end(input);
    });
  }
  const CONTINUE = { decision: 'continue' };

  it('stays out of a session the gateway does not run', async () => {
    expect((await run(payload(), { FLEETHERD_TURN_TOKEN: undefined })).out).toEqual({});
  });

  it('lets a cancelled, failed or spent turn end as agy decided', async () => {
    for (const terminationReason of ['USER_CANCELED', 'ERROR', 'MAX_INVOCATIONS']) {
      expect((await run(payload({ terminationReason }))).out).toEqual({});
    }
  });

  it('lets the turn end when nothing runs in the background', async () => {
    expect((await run(payload({ fullyIdle: true }))).out).toEqual({});
    // No `fullyIdle` at all is read as idle: never hold a turn on a guess.
    expect((await run(JSON.stringify({ conversationId: conv, terminationReason: 'NO_TOOL_CALL' }))).out).toEqual({});
  });

  it('continues at once when a task finished just as the model stopped', async () => {
    message('m1');
    expect((await run(payload({ fullyIdle: true }))).out).toEqual(CONTINUE);
  });

  it('wakes for nothing agy has read, nor for a low-priority notice', async () => {
    message('m1');
    markRead('m1');
    message('m2', 'MESSAGE_PRIORITY_LOW');
    expect((await run(payload({ fullyIdle: true }))).out).toEqual({});
  });

  const seenFile = (): string => path.join(dir, `fleetherd-agy-wait.${os.userInfo().uid}.${conv}`);

  it('acts on a message once, so one agy leaves unread cannot keep the turn going', async () => {
    message('m1');
    expect((await run(payload({ fullyIdle: true }))).out).toEqual(CONTINUE);
    expect((await run(payload({ fullyIdle: true }))).out).toEqual({});
    // Still unread, so still remembered.
    expect(fs.readFileSync(seenFile(), 'utf8')).toBe('m1\n');
  });

  it('forgets a message once agy has read it, leaving nothing behind', async () => {
    message('m1');
    expect((await run(payload({ fullyIdle: true }))).out).toEqual(CONTINUE);
    markRead('m1');
    expect((await run(payload({ fullyIdle: true }))).out).toEqual({});
    expect(fs.existsSync(seenFile())).toBe(false);
  });

  it('waits, silently, until the mailbox has something new', async () => {
    markRead();
    const pending = run(payload());
    setTimeout(() => message('m1'), 1500);
    const { out, ms } = await pending;
    expect(out).toEqual(CONTINUE);
    expect(ms).toBeGreaterThanOrEqual(1500);
    expect(ms).toBeLessThan(8000);
  });

  it('lets the model go when the window passes with nothing new', async () => {
    const { out, ms } = await run(payload(), { FLEETHERD_AGY_WAIT_WINDOW_S: '2' });
    expect(out).toEqual(CONTINUE);
    expect(ms).toBeGreaterThanOrEqual(2000);
  });

  it('finds the mailbox by conversation id when the payload has no transcript path', async () => {
    const homeBox = path.join(dir, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'messages');
    fs.mkdirSync(homeBox, { recursive: true });
    fs.writeFileSync(path.join(homeBox, 'm9.json'), JSON.stringify({ id: 'm9', priority: 'MESSAGE_PRIORITY_HIGH' }));
    const { out } = await run(JSON.stringify({ conversationId: conv, terminationReason: 'NO_TOOL_CALL', fullyIdle: true }));
    expect(out).toEqual(CONTINUE);
  });
});
