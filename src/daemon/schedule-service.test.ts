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
