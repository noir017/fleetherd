import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalTopics } from './external-topics.js';

/**
 * The ownership record's key is the topic's own id (`<platform>:<channel>[/<thread>]`), not the
 * conversation id it has under the current session scope. A version-1 file, keyed by conversation
 * id, is migrated in place so a `/reload` that changes the scope cannot lose it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fileWith(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-topics-'));
  dirs.push(dir);
  const file = path.join(dir, 'external-topics.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

const v1 = {
  version: 1,
  topics: [
    {
      key: 'web#main#e1000000',
      caller: 'gem',
      platform: 'web',
      address: { channel: 'main', thread: 'e1000000' },
      title: '[gem] tasks',
      openedAt: '2026-11-19T00:00:00.000Z',
    },
  ],
};

describe('ExternalTopics keys', () => {
  it('reads a version-1 file by the topic\'s own id, and rewrites it in that form', () => {
    const file = fileWith(v1);
    const topics = new ExternalTopics(file);

    expect(topics.get('web', { channel: 'main', thread: 'e1000000' })).toMatchObject({
      key: 'web:main/e1000000',
      caller: 'gem',
    });
    expect(topics.of('gem')).toHaveLength(1);

    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; topics: Array<{ key: string }> };
    expect(written.version).toBe(2);
    expect(written.topics[0]!.key).toBe('web:main/e1000000');
  });

  it('adds and removes by platform and address, not by conversation id', () => {
    const file = fileWith({ version: 2, topics: [] });
    const topics = new ExternalTopics(file);
    topics.add({
      caller: 'gem',
      platform: 'web',
      address: { channel: 'main', thread: 't1' },
      title: '[gem] one',
      openedAt: '2026-11-19T00:00:00.000Z',
    });

    expect(topics.get('web', { channel: 'main', thread: 't1' })?.caller).toBe('gem');
    expect(topics.get('web', { channel: 'main', thread: 't2' })).toBeUndefined();
    topics.remove('web', { channel: 'main', thread: 't1' });
    expect(topics.get('web', { channel: 'main', thread: 't1' })).toBeUndefined();
  });
});
