import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTask, type ScheduleTask } from '../core/schedule.js';
import { parseConfig } from '../config/schema.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleStore } from './schedule-store.js';

/**
 * `setTags` is the web panel's tag editor — the one write that is not `ScheduleService.op`.
 * What matters is that it holds the line the CLI does (normalize, refuse a bad tag), that an
 * empty set removes the field rather than storing `[]`, and that a label never disturbs the
 * rest of the task or disappears on a reload.
 */

const NOW = Date.UTC(2026, 10, 7, 4, 0, 0);
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(tags?: string[]): { service: ScheduleService; store: ScheduleStore; file: string; task: ScheduleTask } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-schedule-service-'));
  dirs.push(dir);
  const file = path.join(dir, 'schedules.json');
  const store = new ScheduleStore(file);
  const built = buildTask(
    { name: 'Morning CI', cron: '0 8 * * *', prompt: 'summarise the failures', ...(tags !== undefined ? { tags } : {}) },
    {
      now: NOW,
      id: 'a1b2c3',
      defaultTz: 'Asia/Shanghai',
      agents: ['cc'],
      from: { key: 'web#main#t1', platform: 'web', agent: 'cc' },
      target: { platform: 'web', address: { channel: 'main', thread: 't1' } },
      targetConversation: { key: 'web#main#t1', agent: 'cc' },
      canOpenTopic: true,
    }
  );
  if (!built.ok) throw new Error(built.error);
  store.put(built.task);
  const config = parseConfig({
    platforms: { web: { type: 'webui', token: 'w' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
  });
  const service = new ScheduleService(
    config,
    new Map(),
    {} as ConstructorParameters<typeof ScheduleService>[2],
    { now: () => NOW, schedule: () => () => {} },
    store,
    path.join(dir, 'runs')
  );
  return { service, store, file, task: built.task };
}

describe('ScheduleService.setTags', () => {
  it('normalizes a set the same way schedule add/edit does', () => {
    const { service, store } = fixture();

    const view = service.setTags('a1b2c3', [' CI ', 'ci', 'Deploy', '发布']);

    expect(view.tags).toBe('ci, deploy, 发布');
    expect(store.get('a1b2c3')!.tags).toEqual(['ci', 'deploy', '发布']);
  });

  it('removes the field when the set is empty, rather than storing []', () => {
    const { service, store } = fixture(['ci']);

    service.setTags('a1b2c3', []);

    expect(store.get('a1b2c3')!.tags).toBeUndefined();
    expect('tags' in store.get('a1b2c3')!).toBe(false);
  });

  it('refuses an unknown id without writing anything', () => {
    const { service, store } = fixture(['ci']);

    expect(() => service.setTags('nope', ['ops'])).toThrow('no scheduled task #nope');
    expect(store.get('a1b2c3')!.tags).toEqual(['ci']);
  });

  it('refuses a tag outside the set, and names what a tag may contain', () => {
    const { service, store } = fixture(['ci']);

    expect(() => service.setTags('a1b2c3', ['release notes'])).toThrow(/may contain only letters, digits and - _ \. \//);
    expect(store.get('a1b2c3')!.tags).toEqual(['ci']);
  });

  it('changes nothing but the tags', () => {
    const { service, store } = fixture(['ci']);
    const { tags: _before, ...before } = store.get('a1b2c3')!;

    service.setTags('a1b2c3', ['ops', 'release']);

    const { tags: _after, ...after } = store.get('a1b2c3')!;
    expect(after).toEqual(before);
  });

  it('is still there after a reload', () => {
    const { service, file } = fixture();

    service.setTags('a1b2c3', ['ops', '发布']);

    expect(new ScheduleStore(file).get('a1b2c3')!.tags).toEqual(['ops', '发布']);
  });
});

/**
 * `editFromPanel` is `edit` for a person on the web UI's task page. The rules are editTask's and
 * are tested there; what this path decides for itself is where a typed directory belongs (the
 * machine the task runs on — a browser is on none of the gateway's), that the card goes to the
 * conversation the task posts to and nowhere else, and that an edit naming neither a model nor an
 * agent does not start an agent to read its model list.
 */
describe('ScheduleService.editFromPanel', () => {
  function panelFixture(run: { cwd?: string; model?: string } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-schedule-panel-edit-'));
    dirs.push(dir);
    const store = new ScheduleStore(path.join(dir, 'schedules.json'));
    const built = buildTask(
      { name: 'Brief', cron: '0 8 * * *', prompt: 'brief me', session: 'new', ...run },
      {
        now: NOW,
        id: 'b2c3d4',
        defaultTz: 'Asia/Shanghai',
        agents: ['cc', 'remote'],
        from: { key: 'web#main#t0', platform: 'web', agent: 'cc' },
        target: { platform: 'web', address: { channel: 'main' } },
        canOpenTopic: true,
      }
    );
    if (!built.ok) throw new Error(built.error);
    store.put(built.task);
    const config = parseConfig({
      platforms: { web: { type: 'webui', token: 'w' } },
      hosts: { box: { ssh: 'u@box.example' } },
      agents: [
        { id: 'cc', harness: 'claude' },
        { id: 'remote', harness: 'claude', host: 'box' },
      ],
      routing: { default: 'cc' },
    });
    const posted: Array<{ address: unknown; text: string }> = [];
    const probes: Array<[string, string, string | undefined]> = [];
    const web = {
      capabilities: { maxMessageLength: 0, thread: true, standaloneThread: true },
      measureRendered: (t: string) => t.length,
      sendMessage: async (address: unknown, text: string) => {
        posted.push({ address, text });
        return { address, messageId: 'm' };
      },
    };
    const registry = {
      boundAgentOf: () => undefined,
      laneFor: (key: string) => (key === 'web#main#t0' ? { platformId: 'web', address: { channel: 'main', thread: 't0' } } : undefined),
      scheduledModelProblem: async (agent: string, model: string, from: string | undefined) => {
        probes.push([agent, model, from]);
        return model === 'nope' ? 'unknown model "nope" for agent "cc"; choose one of: m1, m2' : undefined;
      },
    };
    const service = new ScheduleService(
      config,
      new Map([['web', web]]) as unknown as ConstructorParameters<typeof ScheduleService>[1],
      registry as unknown as ConstructorParameters<typeof ScheduleService>[2],
      { now: () => NOW, schedule: () => () => {} },
      store,
      path.join(dir, 'runs')
    );
    return { service, store, posted, probes, dir };
  }

  it('changes the prompt, and posts the card only where the task posts — the page is the editor\'s acknowledgement', async () => {
    const { service, store, posted } = panelFixture();

    await service.editFromPanel('b2c3d4', { prompt: 'brief me on CI' });
    await new Promise((r) => setImmediate(r));

    expect(store.get('b2c3d4')!.run).toMatchObject({ kind: 'agent', prompt: 'brief me on CI' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.address).toEqual({ channel: 'main' });
    expect(posted[0]!.text).toContain('brief me on CI');
  });

  it('reads a typed directory as a path on the machine the task runs on, absolute and there', async () => {
    const { service, store, dir } = panelFixture();

    await expect(service.editFromPanel('b2c3d4', { cwd: 'relative/dir' })).rejects.toThrow(
      `the directory has to be an absolute path on the gateway's machine; "relative/dir" is not`
    );
    await expect(service.editFromPanel('b2c3d4', { cwd: path.join(dir, 'missing') })).rejects.toThrow(
      /is not a directory on the gateway's machine; nothing was stored/
    );
    expect(store.get('b2c3d4')!.run.cwd).toBeUndefined();

    await service.editFromPanel('b2c3d4', { cwd: dir });
    expect(store.get('b2c3d4')!.run.cwd).toBe(dir);
    // On another machine the check runs there; with no link to it, nothing is stored.
    await expect(service.editFromPanel('b2c3d4', { agent: 'remote', cwd: '/srv/app' })).rejects.toThrow(
      'host "box" is not connected right now, so the directory /srv/app could not be checked'
    );
    expect(store.get('b2c3d4')!.run).toMatchObject({ agent: 'cc', cwd: dir });
  });

  it('refuses to move a task to another machine with the directory it had here, and empties one on null', async () => {
    const { service, store, dir } = panelFixture();
    await service.editFromPanel('b2c3d4', { cwd: dir });

    await expect(service.editFromPanel('b2c3d4', { agent: 'remote' })).rejects.toThrow(
      `this task runs on box after this edit, but keeps its directory ${dir}, a path on the gateway's machine`
    );
    await service.editFromPanel('b2c3d4', { agent: 'remote', cwd: null });
    expect(store.get('b2c3d4')!.run).toMatchObject({ agent: 'remote' });
    expect(store.get('b2c3d4')!.run.cwd).toBeUndefined();
  });

  it('asks the agent for its models only when the edit names a model or an agent', async () => {
    const { service, store, probes } = panelFixture({ model: 'm1' });

    await service.editFromPanel('b2c3d4', { name: 'Morning brief' });
    expect(probes).toEqual([]);

    await expect(service.editFromPanel('b2c3d4', { model: 'nope' })).rejects.toThrow('choose one of: m1, m2');
    expect(store.get('b2c3d4')!.run).toMatchObject({ model: 'm1' });
    // No conversation to borrow a session from: the probe gets a key of its own.
    expect(probes).toEqual([['cc', 'nope', undefined]]);

    await service.editFromPanel('b2c3d4', { model: null });
    expect(store.get('b2c3d4')!.run.kind === 'agent' && store.get('b2c3d4')!.run).not.toHaveProperty('model');
    expect(store.get('b2c3d4')!.name).toBe('Morning brief');
  });

  it('says what editTask says when the change cannot be made, and writes nothing', async () => {
    const { service, store, posted } = panelFixture();
    const before = store.get('b2c3d4');

    await expect(service.editFromPanel('b2c3d4', { cron: 'not a cron' })).rejects.toThrow(/^--cron: /);
    await expect(service.editFromPanel('b2c3d4', { bash: 'ls' })).rejects.toThrow(/edit does not change a task's kind/);
    await expect(service.editFromPanel('zzzz', { name: 'x' })).rejects.toThrow('no scheduled task #zzzz');
    expect(store.get('b2c3d4')).toBe(before);
    expect(posted).toEqual([]);
  });
});
