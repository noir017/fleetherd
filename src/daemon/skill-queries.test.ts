import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FOLLOW_UP_MS, missesOf, queryLogPath, readQueryEvents, recordQueryEvent, summarizeQueries, type QueryEvent } from './skill-queries.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-queries-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-06T00:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

describe('the query log', () => {
  it('appends and reads back, skipping a line cut mid-write', () => {
    recordQueryEvent(dir, { kind: 'search', at: at(0), conversation: 'c1', query: 'deploy', hits: [] });
    fs.appendFileSync(queryLogPath(dir), '{"kind":"sea');
    fs.appendFileSync(queryLogPath(dir), '\n');
    recordQueryEvent(dir, { kind: 'show', at: at(1), conversation: 'c1', name: 'deploy-check' });
    expect(readQueryEvents(dir).map((e) => e.kind)).toEqual(['search', 'show']);
  });
});

describe('summarizeQueries', () => {
  const events: QueryEvent[] = [
    { kind: 'search', at: at(0), conversation: 'c1', query: 'nothing here', hits: [] },
    { kind: 'search', at: at(1000), conversation: 'c1', query: 'servers', hits: ['server-ops'] },
    { kind: 'show', at: at(2000), conversation: 'c1', name: 'server-ops' },
    { kind: 'search', at: at(3000), conversation: 'c2', query: 'gateway', hits: ['newapi-ops'] },
    // c1 reading newapi-ops does not follow up c2's search.
    { kind: 'show', at: at(4000), conversation: 'c1', name: 'newapi-ops' },
    { kind: 'search', at: at(5000), conversation: 'c3', query: 'mail', hits: ['email-reader'] },
    { kind: 'show', at: at(5000 + FOLLOW_UP_MS + 1), conversation: 'c3', name: 'email-reader' },
  ];

  it('lists misses, and hits nobody in that conversation opened in time, newest first', () => {
    const s = summarizeQueries(events, T0 + 10 * FOLLOW_UP_MS);
    expect(s.misses.map((m) => m.query)).toEqual(['nothing here']);
    expect(s.unread.map((m) => m.query)).toEqual(['mail', 'gateway']);
  });

  it('does not judge a search still inside its follow-up window', () => {
    // gateway's window has closed; mail's (two seconds later) has not.
    const s = summarizeQueries(events, T0 + 3000 + FOLLOW_UP_MS + 1);
    expect(s.unread.map((m) => m.query)).toEqual(['gateway']);
    expect(summarizeQueries(events, T0 + 3500).unread).toEqual([]);
  });

  it('gives the review one conversation\'s misses since a time, once each', () => {
    const more: QueryEvent[] = [...events, { kind: 'search', at: at(9000), conversation: 'c1', query: 'nothing here', hits: [] }];
    expect(missesOf(more, 'c1', T0)).toEqual(['nothing here']);
    expect(missesOf(more, 'c1', T0 + 10_000)).toEqual([]);
    expect(missesOf(more, 'c2', T0)).toEqual([]);
  });
});
