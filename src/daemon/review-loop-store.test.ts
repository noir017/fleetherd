import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewLoopStore, type ReviewLoop } from './review-loop-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-loops-'));
  dirs.push(dir);
  return path.join(dir, 'review-loops.json');
}

describe('ReviewLoopStore', () => {
  it('round-trips loops atomically with 0600 permissions', () => {
    const file = tmpFile();
    const store = new ReviewLoopStore(file);
    expect(store.load()).toEqual([]);

    const loop: ReviewLoop = {
      work: 'web#main#c1000000',
      workTopic: 'web:main/c1000000',
      plan: { agent: 'cx', text: 'check; fleetherd task-verdict pass|nits|changes', rounds: 3 },
      sentBack: 1,
      reviewed: 'a'.repeat(40),
      pending: 'b'.repeat(40),
      review: { key: 'web#main#c2000000', address: { channel: 'main', thread: 'c2000000' }, topic: 'web:main/c2000000' },
      phase: 'review',
      verdict: 'changes',
    };
    store.save([loop]);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new ReviewLoopStore(file).load()).toEqual([loop]);
  });

  it('degrades to empty on corrupt JSON and ignores malformed entries', () => {
    const file = tmpFile();
    const logs: string[] = [];
    fs.writeFileSync(file, '{not json');
    expect(new ReviewLoopStore(file, (l) => logs.push(l)).load()).toEqual([]);
    expect(logs.some((l) => l.includes('could not read'))).toBe(true);

    fs.writeFileSync(file, JSON.stringify({ version: 1, loops: [{ bad: true }] }));
    expect(new ReviewLoopStore(file).load()).toEqual([]);
  });
});
