import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instructionsLayer } from '../config/instructions.js';
import { parseConfig, type AgentConnect, type AgentDef, type Config } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';
import { createAcpAgentFactory } from './agent-acp.js';
import { agyPluginProvision } from './agy-plugin.js';
import { connectHere, connectMeta, type ConnectPlace } from './connect-agent.js';
import { composeInstructions, INSTRUCTIONS_MAX_BYTES, instructionsDir, instructionsProvision } from './instructions.js';
import { deliveredTo, managedSkillsProvision } from './managed-skills.js';
import { bundledSkillProvision } from './skill-link.js';
import { activeSkillFiles, frontmatterFields, SKILL_FILE } from './skills-store.js';
import type { AgentProvision } from './provision.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/** A TCP server on 127.0.0.1; `serve` gets each connection. */
async function server(serve: (socket: net.Socket) => void): Promise<number> {
  const srv = net.createServer(serve);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => srv.close());
  return (srv.address() as net.AddressInfo).port;
}

const exited = (child: { on(e: 'exit', l: (code: number | null) => void): unknown }): Promise<number | null> =>
  new Promise((r) => child.on('exit', (code) => r(code)));

describe('a connection as an agent process', () => {
  it('carries both ways, writes what was queued before a SIGTERM, then half-closes and exits when the agent does', async () => {
    let heard = '';
    const port = await server((s) => {
      s.write('hello from the agent\n');
      s.on('data', (d: Buffer) => (heard += d.toString()));
      s.on('end', () => s.end('bye\n')); // the agent still speaks after our half-close
    });
    const child = connectHere({ url: `tcp://127.0.0.1:${port}` });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exit = exited(child);
    child.stdin.write('session/cancel\n');
    expect(child.kill()).toBe(true);
    expect(await exit).toBe(0);
    expect(heard).toBe('session/cancel\n');
    expect(out).toBe('hello from the agent\nbye\n');
    expect(child.kill()).toBe(false);
  });

  it('reports an address with nothing there as an error and an exit, the way a missing command is', async () => {
    const port = await server(() => {});
    cleanup.pop()!(); // closed: nothing listens on the port now
    const child = connectHere({ url: `tcp://127.0.0.1:${port}` });
    const error = new Promise<Error>((r) => child.on('error', r));
    expect(await exited(child)).toBe(1);
    expect((await error).message).toMatch(/ECONNREFUSED/);
  });
});

describe('what a connect agent is told in initialize', () => {
  const allProvisions = [bundledSkillProvision, agyPluginProvision, instructionsProvision, managedSkillsProvision];

  it('its meta as written, and the token, machine and instructions under fleetherd', async () => {
    const dir = makeTempDir('fh-connect-');
    const token = join(dir, 'token');
    writeFileSync(token, '  s3cret-token\n');
    const configDir = join(dir, 'config');
    mkdirSync(join(configDir, 'instructions'), { recursive: true });
    writeFileSync(join(configDir, 'instructions', 'common.md'), 'Be brief.');
    writeFileSync(join(configDir, 'instructions', 'web.md'), 'Say where.');
    process.env.FLEETHERD_CONFIG_DIR = configDir;
    cleanup.push(() => delete process.env.FLEETHERD_CONFIG_DIR);
    const connect = { url: 'tcp://127.0.0.1:1', tokenFile: token, meta: { wad: { site: 'gemini-task', profile: 'main' } } };
    const def = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'web', harness: 'custom', connect }],
      routing: { default: 'web', pipeline: [] },
    }).agents[0]!;
    expect(await connectMeta(def, connect, undefined, allProvisions)).toEqual({
      wad: { site: 'gemini-task', profile: 'main' },
      fleetherd: { token: 's3cret-token', host: hostname(), instructions: 'Be brief.\n\nSay where.\n' },
    });
    // A pod's agent gets the layer of its own id, without the host.
    const pod = { ...def, id: 'web@box', host: 'box' };
    const place = { host: { id: 'box', readFile: async () => Buffer.from('remote-token') }, welcome: { home: '/home/u' } };
    const meta = await connectMeta(pod, connect, place as unknown as Parameters<typeof connectMeta>[2], allProvisions);
    expect(meta['fleetherd']).toEqual({ token: 'remote-token', host: 'box', instructions: 'Be brief.\n\nSay where.\n' });
  });

  it('includes resident skills reaching the agent in initialize _meta.fleetherd.skills', async () => {
    const dir = makeTempDir('fh-connect-skills-');
    const configDir = join(dir, 'config');
    mkdirSync(join(configDir, 'skills', 'skills', 'server-ops'), { recursive: true });
    writeFileSync(
      join(configDir, 'skills', 'skills', 'server-ops', 'SKILL.md'),
      '---\nname: server-ops\ndescription: Use when operating servers over SSH\nmetadata:\n  fleetherd-resident: "true"\n---\n# Body\n'
    );
    mkdirSync(join(configDir, 'skills', 'skills', 'lib-only'), { recursive: true });
    writeFileSync(
      join(configDir, 'skills', 'skills', 'lib-only', 'SKILL.md'),
      '---\nname: lib-only\ndescription: Library skill not resident\n---\n# Body\n'
    );
    process.env.FLEETHERD_CONFIG_DIR = configDir;
    cleanup.push(() => delete process.env.FLEETHERD_CONFIG_DIR);
    const connect = { url: 'tcp://127.0.0.1:1' };
    const def = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'web', harness: 'custom', connect }],
      routing: { default: 'web', pipeline: [] },
    }).agents[0]!;
    const meta = await connectMeta(def, connect, undefined, allProvisions);
    expect((meta['fleetherd'] as Record<string, unknown>)['skills']).toEqual([
      { name: 'server-ops', description: 'Use when operating servers over SSH' },
    ]);
  });

  it('matches the pre-provision connectMeta output verbatim across token/instructions/skills/topic combinations and over-limit instructions', async () => {
    // Reference implementation matching the pre-refactor connectMeta behavior.
    const legacyConnectMeta = async (
      def: AgentDef,
      connect: AgentConnect,
      place: ConnectPlace | undefined,
      topic?: string,
      tokenValue?: string
    ): Promise<Record<string, unknown>> => {
      const gateway: Record<string, unknown> = { host: place ? place.host.id : hostname() };
      if (connect.tokenFile && tokenValue !== undefined) gateway['token'] = tokenValue;
      const layer = instructionsLayer(def);
      if (layer !== undefined) {
        const composed = composeInstructions(instructionsDir(), layer);
        if (composed.kind === 'text') gateway['instructions'] = composed.text;
      }
      const skills: Array<{ name: string; description: string }> = [];
      for (const skill of activeSkillFiles()) {
        if (!skill.meta.resident || !deliveredTo(skill, def)) continue;
        const raw = skill.files.get(SKILL_FILE)?.toString('utf8') ?? '';
        const description = frontmatterFields(raw).get('description')?.trim();
        if (description) skills.push({ name: skill.name, description });
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
      if (skills.length > 0) gateway['skills'] = skills;
      if (topic) gateway['topic'] = topic;
      return { ...(connect.meta ?? {}), fleetherd: gateway };
    };

    const makeDef = (connect: AgentConnect): AgentDef =>
      parseConfig({
        platforms: { discord: { type: 'discord', token: 't' } },
        agents: [{ id: 'web', harness: 'custom', connect }],
        routing: { default: 'web', pipeline: [] },
      }).agents[0]!;

    const writeSkill = (configDir: string, name: string, description: string, resident: boolean): void => {
      const dir = join(configDir, 'skills', 'skills', name);
      mkdirSync(dir, { recursive: true });
      const residentLine = resident ? 'metadata:\n  fleetherd-resident: "true"\n' : '';
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${residentLine}---\n# Body\n`);
    };

    const runCase = async (opts: {
      withToken: boolean;
      instructions: 'none' | 'normal' | 'too-big';
      withSkills: boolean;
      topic?: string;
      remoteHost?: string;
    }): Promise<void> => {
      const dir = makeTempDir('fh-connect-equiv-');
      const configDir = join(dir, 'config');
      mkdirSync(configDir, { recursive: true });
      if (opts.instructions === 'normal') {
        mkdirSync(join(configDir, 'instructions'), { recursive: true });
        writeFileSync(join(configDir, 'instructions', 'common.md'), 'Keep replies concise.');
        writeFileSync(join(configDir, 'instructions', 'web.md'), 'Include source paths.');
      } else if (opts.instructions === 'too-big') {
        mkdirSync(join(configDir, 'instructions'), { recursive: true });
        writeFileSync(join(configDir, 'instructions', 'common.md'), 'x'.repeat(INSTRUCTIONS_MAX_BYTES + 16));
      }
      if (opts.withSkills) {
        // Deliberately write out of alphabetical order to verify stable name sorting.
        writeSkill(configDir, 'zeta-tool', 'Zeta resident skill', true);
        writeSkill(configDir, 'alpha-tool', 'Alpha resident skill', true);
        writeSkill(configDir, 'library-only', 'Non-resident skill', false);
      }
      const tokenFile = opts.withToken ? join(dir, 'token') : undefined;
      if (tokenFile) writeFileSync(tokenFile, '  tok-123\n');
      const connect: AgentConnect = {
        url: 'tcp://127.0.0.1:1',
        ...(tokenFile ? { tokenFile } : {}),
        meta: { custom: { profile: 'default' } },
      };
      const def = makeDef(connect);
      const place = opts.remoteHost
        ? ({ host: { id: opts.remoteHost, readFile: async () => Buffer.from('tok-123') }, welcome: { home: '/home/me' } } as unknown as ConnectPlace)
        : undefined;

      const prevConfigDir = process.env.FLEETHERD_CONFIG_DIR;
      process.env.FLEETHERD_CONFIG_DIR = configDir;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const actual = await connectMeta(def, connect, place, allProvisions, opts.topic);
        const expected = await legacyConnectMeta(def, connect, place, opts.topic, opts.withToken ? 'tok-123' : undefined);
        expect(actual).toEqual(expected);
        expect(Object.keys(actual['fleetherd'] as Record<string, unknown>)).toEqual(
          Object.keys(expected['fleetherd'] as Record<string, unknown>)
        );
        if (opts.instructions === 'too-big') {
          expect((actual['fleetherd'] as Record<string, unknown>)['instructions']).toBeUndefined();
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringMatching(/^\[connect\] web: instructions not sent, \d+ bytes is over the limit$/)
          );
        } else {
          expect(warnSpy).not.toHaveBeenCalled();
        }
      } finally {
        warnSpy.mockRestore();
        if (prevConfigDir === undefined) delete process.env.FLEETHERD_CONFIG_DIR;
        else process.env.FLEETHERD_CONFIG_DIR = prevConfigDir;
      }
    };

    await runCase({ withToken: false, instructions: 'none', withSkills: false });
    await runCase({ withToken: true, instructions: 'normal', withSkills: true, topic: 'web:main/0123abcd' });
    await runCase({ withToken: true, instructions: 'normal', withSkills: true, topic: 'web:main/0123abcd', remoteHost: 'myhost' });
    await runCase({ withToken: false, instructions: 'normal', withSkills: false, topic: 'web:main/deadbeef' });
    await runCase({ withToken: true, instructions: 'none', withSkills: true });
    await runCase({ withToken: true, instructions: 'too-big', withSkills: true, topic: 'web:main/cafebabe' });
  });

  it('says which file it could not read', async () => {
    const connect = { url: 'tcp://127.0.0.1:1', tokenFile: '/nonexistent/token' };
    const def = { id: 'web', connect } as unknown as Parameters<typeof connectMeta>[0];
    await expect(connectMeta(def, connect, undefined, [])).rejects.toThrow('agent "web": cannot read connect.tokenFile /nonexistent/token');
  });
});

describe('the config of a connect agent', () => {
  const agents = (a: Record<string, unknown>): unknown =>
    parseConfig({ platforms: { discord: { type: 'discord', token: 't' } }, agents: [{ id: 'web', harness: 'custom', ...a }], routing: { default: 'web', pipeline: [] } });

  it('takes connect in place of command, and nothing that needs a process or a file', () => {
    expect(() => agents({ connect: { url: 'tcp://wad:7790' } })).not.toThrow();
    expect(() => agents({ connect: { url: 'tcp://[::1]:7790', tokenFile: '~/.wad/token' } })).not.toThrow();
    expect(() => agents({})).toThrow('command (or connect) is required');
    expect(() => agents({ command: 'wad', connect: { url: 'tcp://wad:7790' } })).toThrow('in place of command');
    expect(() => agents({ connect: { url: 'http://wad:7790' } })).toThrow('connect.url is tcp://host:port');
    expect(() => agents({ connect: { url: 'tcp://wad:7790', tokenFile: 'token' } })).toThrow('connect.tokenFile');
    expect(() => agents({ connect: { url: 'tcp://wad:7790' }, instructions: { file: '~/x.md' } })).toThrow('initialize _meta');
  });
});

/** An ACP agent on a port: answers initialize, session/new and prompts; a prompt saying `slow` waits for a cancel. */
async function fakeAgent(): Promise<{ port: number; heard: string[]; meta: () => unknown; closed: Promise<void> }> {
  const heard: string[] = [];
  let meta: unknown;
  let closed!: () => void;
  const done = new Promise<void>((r) => (closed = r));
  const port = await server((s) => {
    const send = (o: object): void => void s.write(`${JSON.stringify(o)}\n`);
    let buf = '';
    const pending = new Map<string, number>();
    s.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number; method?: string; params?: Record<string, unknown> };
        buf = buf.slice(nl + 1);
        if (msg.method) heard.push(msg.method);
        if (msg.method === 'initialize') {
          meta = msg.params?.['_meta'];
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (msg.method === 'session/new') {
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
        } else if (msg.method === 'session/prompt') {
          const words = JSON.stringify(msg.params?.['prompt']);
          if (words.includes('slow')) pending.set('s1', msg.id!);
          else send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else if (msg.method === 'session/cancel') {
          const id = pending.get('s1');
          if (id !== undefined) send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
        }
      }
    });
    s.on('end', () => {
      heard.push('EOF');
      s.end();
      closed();
    });
  });
  return { port, heard, meta: () => meta, closed: done };
}

const quiet: AgentStreamHandlers = { onText: () => {}, onToolStart: () => {}, onToolFinish: () => {}, onSegmentBreak: () => {} };

describe('a connect agent as a conversation', () => {
  let live: AgentSession | undefined;
  afterEach(() => live?.dispose());

  it('dials per session, says who it is in _meta, and on End agent sends the cancel before it hangs up', async () => {
    const agent = await fakeAgent();
    const dir = makeTempDir('fh-connect-');
    const cfg: Config = parseConfig({
      platforms: { discord: { type: 'discord', token: 't' } },
      agents: [{ id: 'web', harness: 'custom', cwd: dir, connect: { url: `tcp://127.0.0.1:${agent.port}`, meta: { wad: { site: 'x', profile: 'p' } } } }],
      routing: { default: 'web', pipeline: [] },
    });
    const store = { agentSession: () => undefined, setAgentSession: () => {}, conversationCwd: () => undefined } as unknown as Parameters<
      typeof createAcpAgentFactory
    >[2];
    const stubProvision: AgentProvision = {
      name: 'stub',
      local: () => {},
      remote: async () => {},
      meta: () => ({ instructions: 'x' }),
    };
    const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store, { provisions: [stubProvision] }).getOrCreate('conv#1', 'web');
    live = session;

    await session.runTurn({ prompt: 'hi', sessionToken: 'tok', topic: 'web:main/3a9f0c12' }, quiet);
    expect(agent.meta()).toEqual({
      wad: { site: 'x', profile: 'p' },
      fleetherd: { host: hostname(), instructions: 'x', topic: 'web:main/3a9f0c12' },
    });

    // End agent: the turn is interrupted (a session/cancel), and the session disposed at once.
    const turn = session.runTurn({ prompt: 'slow work', sessionToken: 'tok' }, quiet);
    await new Promise((r) => setTimeout(r, 100));
    session.abort();
    session.dispose();
    live = undefined;
    await turn.catch(() => {});
    await agent.closed;
    expect(agent.heard).toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt', 'session/cancel', 'EOF']);
  });
});
