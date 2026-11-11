import { formatTarget, type ConversationAddress } from './conversation.js';

/**
 * `fleetherd channels` as data: the places this gateway can post to, in the id form every
 * reverse command's `--channel` (and a schedule's `--to`) accepts.
 *
 * ── Why the list is "what the daemon has seen" ────────────────────────────────────────────────
 * Most platforms cannot enumerate where a bot is. The Telegram Bot API has no call that lists a
 * bot's chats at all; a webhook-style bot on the others only learns of a channel when something is
 * said in it. So the honest source is the conversation store: every place a turn has run, with the
 * title the gateway gave it and when it was last used. That also makes the list the right one —
 * a place nobody has talked to the bot in is not a place anyone expects its output.
 *
 * Pure: the caller hands over the records, the configured instances and the clock-free options.
 */

/** One conversation as the store holds it — the subset this list reads. */
export interface ChannelSource {
  /** The conversation key (opaque; read only by the legacy fallback below). */
  key: string;
  agent: string;
  title?: string;
  lane?: { platform: string; channel: string; thread?: string };
  lastAt?: number;
}

export interface ChannelRow {
  /** `<instance>:<channel>[/<thread>]` — paste straight into `--channel` / `--to`. */
  id: string;
  /** A channel root (where a new topic can be opened) or one topic / thread inside it. */
  kind: 'channel' | 'topic';
  /** The instance's platform type (`telegram`, `webui`, `lark` …), so the id's prefix is legible. */
  platform: string;
  title: string;
  /** The agent bound there; empty on a channel row that is not itself a conversation. */
  agent: string;
  /** ISO time of the last turn, or empty when the record predates the field. */
  lastAt: string;
  /** Whether this is the conversation asking. */
  current: boolean;
}

export interface ChannelListOptions {
  /** Instance id → platform type, for every configured instance. Rows on any other are dropped. */
  instances: ReadonlyMap<string, string>;
  /** Only this instance. */
  platform?: string;
  /** Case-insensitive substring over id, title and agent. */
  query?: string;
  /** How many TOPIC rows to return (channel rows are few and always all shown). */
  limit: number;
  /** The asking conversation's key, marked `current`. */
  currentKey?: string;
}

export interface ChannelList {
  rows: ChannelRow[];
  /** Topic rows that matched before the limit cut them. */
  totalTopics: number;
}

/**
 * Where a record written before `lane` existed was answered, read off its key.
 *
 * ⚠️ Keys are opaque by design (core/conversation.ts KEY_SEP) and this is the ONE place that reads
 * one back, as a migration aid: the store gained `lane` on 2026-09-30, and without this every
 * conversation older than the upgrade — 335 on the live deployment that day — would be missing from
 * the list until someone happened to talk in it again. Only the two scope shapes that name a place
 * are read (`<instance>#<channel>#<thread|>` and `<instance>#<channel>`), only for a configured
 * instance, and a key with any other number of `#` fields is skipped rather than guessed at — so a
 * channel id that itself contains `#` is left out, not mis-split. Each such record gets a real
 * `lane` on its next turn and never comes through here again.
 */
export function laneFromLegacyKey(
  key: string,
  instances: ReadonlyMap<string, string>
): ChannelSource['lane'] {
  const parts = key.split('#');
  const [platform, channel, thread] = parts;
  if (!platform || !channel || !instances.has(platform)) return undefined;
  if (channel === 'u') return undefined; // per_user: `<instance>#u#<user>` names a person, not a place
  if (parts.length === 2) return { platform, channel };
  if (parts.length === 3) return thread ? { platform, channel, thread } : { platform, channel };
  return undefined;
}

/** Build the list: channel roots first (all of them), then the most recently used topics. */
export function buildChannelList(sources: readonly ChannelSource[], opts: ChannelListOptions): ChannelList {
  const query = opts.query?.trim().toLowerCase();
  const matches = (row: ChannelRow): boolean =>
    !query || [row.id, row.title, row.agent].some((s) => s.toLowerCase().includes(query));

  // Newest first. The store is in insertion order, so for records with no lastAt the reverse of
  // that order is the best available proxy for recency (newer conversations were created later).
  const ordered = sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (b.s.lastAt ?? -1) - (a.s.lastAt ?? -1) || b.i - a.i)
    .map(({ s }) => s);

  const channels = new Map<string, ChannelRow>();
  const topics: ChannelRow[] = [];
  for (const s of ordered) {
    const lane = s.lane ?? laneFromLegacyKey(s.key, opts.instances);
    if (!lane) continue;
    const type = opts.instances.get(lane.platform);
    if (type === undefined) continue;
    if (opts.platform && lane.platform !== opts.platform) continue;
    const root: ConversationAddress = { channel: lane.channel };
    const rootId = formatTarget(lane.platform, root);
    const lastAt = s.lastAt !== undefined ? new Date(s.lastAt).toISOString() : '';
    const current = s.key === opts.currentKey;

    // Sorted newest first, so the first sighting of a channel carries its most recent use.
    if (!channels.has(rootId)) {
      channels.set(rootId, { id: rootId, kind: 'channel', platform: type, title: '', agent: '', lastAt, current: false });
    }
    if (lane.thread === undefined) {
      // The channel root is itself a conversation: its row carries that conversation's facts.
      const row = channels.get(rootId)!;
      row.title = row.title || (s.title ?? '');
      row.agent = row.agent || s.agent;
      row.current = row.current || current;
      continue;
    }
    topics.push({
      id: formatTarget(lane.platform, { channel: lane.channel, thread: lane.thread }),
      kind: 'topic',
      platform: type,
      title: s.title ?? '',
      agent: s.agent,
      lastAt,
      current,
    });
  }

  const matchedTopics = topics.filter(matches);
  const limit = Math.max(1, opts.limit);
  return {
    rows: [...[...channels.values()].filter(matches), ...matchedTopics.slice(0, limit)],
    totalTopics: matchedTopics.length,
  };
}
