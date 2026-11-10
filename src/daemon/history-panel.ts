import type { HistoryReadCut, HistorySessionRow, HistoryStore } from '../history/store.js';
import type {
  HistoryPanel,
  HistoryPanelPage,
  HistoryPanelRead,
  HistoryPanelSearch,
  HistoryPanelSession,
} from '../platform/adapter.js';

/**
 * The daemon's side of the web UI's history page: `history.db` read the way `talkcode sessions`
 * reads it, for a browser.
 *
 * The page shows what the library holds, not what this daemon still has in memory: a topic that
 * was cleared from the switcher is still here, and so is every conversation from every other
 * platform. The only link back is a topic this instance still lists — `session.topic` is left off
 * otherwise, because a button that opens nothing is worse than no button.
 *
 * Read-only. Nothing here writes a row: the library is written as turns happen.
 */

/** How many conversations one page carries. A screenful, so the page is useful before it scrolls. */
export const HISTORY_PAGE_LIMIT = 50;

/** How many keyword matches one search answers with. More than a page, fewer than a flood. */
export const HISTORY_SEARCH_LIMIT = 30;

export interface HistoryPanelOptions {
  history: HistoryStore;
  /** The web UI instance showing the page; a conversation of another instance gets no topic link. */
  instance: string;
  max?: number;
}

export function buildHistoryPanel(options: HistoryPanelOptions): HistoryPanel {
  const page = Math.max(1, Math.min(options.max ?? HISTORY_PAGE_LIMIT, 200));

  const list = (opts: { before?: string; limit?: number } = {}): HistoryPanelPage => {
    const limit = Math.max(1, Math.min(opts.limit ?? page, 200));
    const before = opts.before ? parseCursor(opts.before) : undefined;
    // One row past the page: its presence is what says there is a next page, without a COUNT
    // over a library that can hold hundreds of thousands of rows.
    const rows = options.history.list({ all: true, limit: limit + 1, ...(before ? { before } : {}) });
    const kept = rows.slice(0, limit);
    const last = kept[kept.length - 1];
    return {
      enabled: true,
      sessions: kept.map((row) => sessionEntry(row, options.instance)),
      ...(rows.length > limit && last ? { next: cursorOf(last) } : {}),
    };
  };

  const search = (query: string): HistoryPanelSearch => {
    // One row past the answer: its presence is what says the count is a floor, not the total.
    const rows = options.history.search(query, { limit: HISTORY_SEARCH_LIMIT + 1 });
    return {
      hits: rows.slice(0, HISTORY_SEARCH_LIMIT).map((hit) => ({
        session: hit.session,
        message: hit.message,
        at: Date.parse(hit.at) || 0,
        title: hit.title,
        agent: hit.agent,
        platform: hit.platform,
        role: hit.role,
        excerpt: hit.excerpt,
      })),
      ...(rows.length > HISTORY_SEARCH_LIMIT ? { more: true } : {}),
    };
  };

  const read = (id: number): HistoryPanelRead => {
    const result = options.history.read(String(id));
    const note = pageNote(result.truncated);
    return {
      session: sessionEntry(result.session, options.instance),
      messages: result.messages.map((message) => ({
        id: message.id,
        at: Date.parse(message.at) || 0,
        role: message.role,
        kind: message.kind,
        text: message.text,
      })),
      ...(note ? { note } : {}),
    };
  };

  return { list, search, read };
}

/**
 * What the page says when a read is not the whole conversation.
 *
 * Its own words, not the store's `note`: that one is written for `sessions read` and names flags
 * (`--around`, `--role tool`) a page has no way to run, and it explains folded tool runs, which
 * the page shows as the lines they are. The facts come from `truncated`, so this cannot drift
 * from what the CLI answered — only the wording differs.
 */
export function pageNote(cut: HistoryReadCut | undefined): string | undefined {
  if (!cut) return undefined;
  const parts: string[] = [];
  if (cut.rows !== undefined) {
    parts.push(`This conversation is longer than the ${cut.rows} messages this page reads; only the first ${cut.rows} are shown.`);
  }
  if (cut.chars !== undefined) parts.push(`${cut.chars} later message(s) are not shown, so the page stays a readable size.`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * The cursor the next page starts after: `<last_at ms>.<id>`.
 *
 * Opaque to the page on purpose — the store orders by `(last_at, id)` today, and a page that had
 * been taught that would have to change with it. A cursor the page cannot parse is refused rather
 * than guessed at, since guessing means a page that silently repeats or skips rows.
 */
export function cursorOf(row: Pick<HistorySessionRow, 'id' | 'lastAt'>): string {
  return `${Date.parse(row.lastAt) || 0}.${row.id}`;
}

function parseCursor(cursor: string): { lastAt: number; id: number } {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(cursor);
  if (!match) throw new Error('that is not a page of this history');
  return { lastAt: Number(match[1]), id: Number(match[2]) };
}

function sessionEntry(row: HistorySessionRow, instance: string): HistoryPanelSession {
  const topic = topicOf(row.key, instance);
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    agent: row.agent,
    platform: row.platform,
    lastAt: Date.parse(row.lastAt) || 0,
    messages: row.messages ?? 0,
    ...(topic ? { topic } : {}),
  };
}

/**
 * The web UI topic a conversation key names, when this instance is the one that recorded it.
 *
 * Keys are `<platform>#<channel>#<thread>` and a web UI topic is always the thread of its single
 * channel, so only the third part can be one. It must also look like a topic id — eight hex
 * characters — because a per-channel conversation's key has no third part at all, and a thread
 * from another platform's key would point the page at a topic it does not have.
 */
function topicOf(key: string, instance: string): string | undefined {
  const parts = key.split('#');
  if (parts[0] !== instance) return undefined;
  const thread = parts[2];
  return thread && /^[0-9a-f]{8}$/.test(thread) ? thread : undefined;
}
