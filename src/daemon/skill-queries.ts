import fs from 'node:fs';
import path from 'node:path';

/**
 * What agents searched the skill library for, and what they then read — the record that says
 * where the library falls short.
 *
 * Two signals, both cheap to read off this log:
 *  - a search that found nothing: the library has no skill for something an agent needed. The
 *    automatic review is shown the ones from the conversation it reviews, as a hint for a skill to
 *    write; the web UI's page lists them for a person.
 *  - a search whose hits nobody opened: the descriptions did not say "this is the one", or the
 *    ranking put the wrong one first. A person reads these on the page.
 *
 * One JSON line per event in `<configDir>/skills-queries.jsonl`, outside the skills repository for
 * the reason the usage file is: it changes on every use. Capped — once past MAX_BYTES it is cut to
 * the newest KEEP_LINES — because it is a hint, not a history anyone audits.
 */

export const QUERY_LOG = 'skills-queries.jsonl';
const MAX_BYTES = 1024 * 1024;
const KEEP_LINES = 2000;

/** How long after a search a read of one of its hits still counts as following it up. */
export const FOLLOW_UP_MS = 30 * 60_000;

export type QueryEvent =
  | { kind: 'search'; at: string; conversation?: string; agent?: string; query: string; hits: string[] }
  | { kind: 'show'; at: string; conversation?: string; agent?: string; name: string };

export function queryLogPath(dir: string): string {
  return path.join(dir, QUERY_LOG);
}

/** Append one event. Best-effort: a log that cannot be written must not fail a search. */
export function recordQueryEvent(dir: string, event: QueryEvent): void {
  try {
    const file = queryLogPath(dir);
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
      fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    }
  } catch (e) {
    console.warn(`[skills] could not record a search: ${e instanceof Error ? e.message : e}`);
  }
}

export function readQueryEvents(dir: string): QueryEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(queryLogPath(dir), 'utf8');
  } catch {
    return [];
  }
  const out: QueryEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as QueryEvent;
      if (e && (e.kind === 'search' || e.kind === 'show')) out.push(e);
    } catch {
      // a line cut by a crash mid-append: skip it
    }
  }
  return out;
}

export interface SearchOutcome {
  at: string;
  query: string;
  conversation?: string;
  agent?: string;
  hits: string[];
}

export interface QuerySummary {
  /** Searches that found no skill, newest first. */
  misses: SearchOutcome[];
  /** Searches that found some, none of which the same conversation opened afterwards, newest first. */
  unread: SearchOutcome[];
}

/**
 * Misses and unread hits, newest first, at most `limit` of each. A search counts as followed up
 * when the same conversation reads one of its hits within FOLLOW_UP_MS; one still inside that window
 * at `now` is not counted either way yet.
 */
export function summarizeQueries(events: QueryEvent[], now: number, limit = 20): QuerySummary {
  const misses: SearchOutcome[] = [];
  const unread: SearchOutcome[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== 'search') continue;
    const outcome: SearchOutcome = {
      at: e.at,
      query: e.query,
      hits: e.hits,
      ...(e.conversation ? { conversation: e.conversation } : {}),
      ...(e.agent ? { agent: e.agent } : {}),
    };
    if (e.hits.length === 0) {
      if (misses.length < limit) misses.push(outcome);
      continue;
    }
    const at = Date.parse(e.at) || 0;
    if (now - at < FOLLOW_UP_MS) continue;
    const read = events.slice(i + 1).some(
      (later) =>
        later.kind === 'show' &&
        later.conversation === e.conversation &&
        e.hits.includes(later.name) &&
        (Date.parse(later.at) || 0) - at <= FOLLOW_UP_MS
    );
    if (!read && unread.length < limit) unread.push(outcome);
  }
  return { misses, unread };
}

/** The searches one conversation made since `sinceMs` that found nothing — for the review. */
export function missesOf(events: QueryEvent[], conversation: string, sinceMs: number): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind !== 'search' || e.conversation !== conversation || e.hits.length > 0) continue;
    if ((Date.parse(e.at) || 0) < sinceMs) continue;
    if (!out.includes(e.query)) out.push(e.query);
  }
  return out;
}
