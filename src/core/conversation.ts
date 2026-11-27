import type { ConversationAddress, ConversationRef, SessionScope } from '../types.js';
export type { ConversationAddress, ConversationKind, ConversationRef } from '../types.js';

/**
 * Conversation identity — the domain type this whole gateway is organized around.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * A chat platform's "where" is not always a single id. Telegram forum topics and
 * Slack threads are a `(channel, sub-lane)` PAIR: the lane is a separate wire
 * parameter (`message_thread_id`, `thread_ts`), not part of the channel id. The
 * previous model had one opaque `channelId: string`, so a topic had to be smuggled
 * through as the composite string `"<chatId>:<topicId>"` — built in five places,
 * decoded in seventeen, validated in none. Every path that forgot to decode sent to
 * the wrong place, and because Telegram truncates a malformed chat_id LENIENTLY in
 * private chats, half those failures were silent.
 *
 * So the pair is a struct. The composite string is gone; it survives only at the two
 * boundaries that genuinely need text (the persisted store key and the `--channel`
 * CLI flag), each with one tested formatter and one validating parser below.
 */

/** Narrow a ref to the fields needed for sending. */
export function addressOf(ref: ConversationRef): ConversationAddress {
  return ref.thread != null ? { channel: ref.channel, thread: ref.thread } : { channel: ref.channel };
}

/** Whether two addresses point at the same place. */
export function sameAddress(a: ConversationAddress, b: ConversationAddress): boolean {
  return a.channel === b.channel && (a.thread ?? '') === (b.thread ?? '');
}

/**
 * Separator for the textual address form. `/` rather than `:` because platform ids
 * legitimately contain `:` (nothing in the tree contains `/`): Slack's `thread_ts` is
 * `1234567890.123456`, Telegram supergroup ids are `-100…`, and the old `:` scheme
 * could not tell `a:b:c` apart from a channel that simply had a colon in it.
 */
const ADDRESS_SEP = '/';

/**
 * Render an address for the two places that need text: the `--channel` CLI flag and
 * log lines. `channel` alone when there is no lane, `channel/thread` when there is.
 */
export function formatAddress(a: ConversationAddress): string {
  return a.thread != null && a.thread !== '' ? `${a.channel}${ADDRESS_SEP}${a.thread}` : a.channel;
}

/**
 * Parse the textual form back, VALIDATING it.
 *
 * The old composite split accepted anything and let a malformed lane reach the API as
 * `Number('99:5') === NaN`, which Telegram rejects with an opaque 400 far from the
 * cause. Here a bad string fails at the boundary, with the offending input named.
 * Throws rather than returning null because both callers (CLI option parsing, IPC
 * request validation) want the message verbatim.
 */
export function parseAddress(s: string): ConversationAddress {
  const bad = (why: string): never => {
    throw new Error(`invalid channel ${JSON.stringify(s)}: ${why} (expected "<channel>" or "<channel>${ADDRESS_SEP}<thread>")`);
  };
  const parts = s.split(ADDRESS_SEP);
  if (parts.length > 2) bad(`too many "${ADDRESS_SEP}" separators`);
  const [channel = '', thread] = parts;
  if (!channel) bad('empty channel');
  if (thread !== undefined && thread === '') bad('empty thread');
  return thread !== undefined ? { channel, thread } : { channel };
}

/**
 * A textual `--channel` / `--to` value, parsed: the address, and the platform INSTANCE it named,
 * if it named one.
 *
 * `platform` is absent for the original form (`<channel>[/<thread>]`), which means "on the platform
 * the calling conversation is on" — an address alone cannot identify a platform, and that form
 * predates there being any way to say which one.
 */
export interface ChannelTarget {
  platform?: string;
  address: ConversationAddress;
}

/**
 * Separator between the instance id and the address in a qualified target (`tg:5865716608/8068`).
 *
 * `:` is safe on the LEFT even though channel ids may contain it (see ADDRESS_SEP): instance ids are
 * `[a-z0-9][a-z0-9_-]{0,31}` (config/schema.ts), so the first `:` is the only candidate, and it is
 * taken as a separator only when what precedes it is a configured instance. A channel id that
 * happens to start with `<an instance id>:` would be misread — named here because it is the one
 * input this cannot tell apart, and no platform in the tree mints ids of that shape.
 */
const TARGET_SEP = ':';

/**
 * `<instance>:<channel>[/<thread>]` — what `channels` prints and what a cross-platform target takes.
 * Round-trips through parseTarget whenever `platform` is a configured instance.
 */
export function formatTarget(platform: string, a: ConversationAddress): string {
  return `${platform}${TARGET_SEP}${formatAddress(a)}`;
}

/**
 * Parse a target, qualified or not, VALIDATING the address part exactly as parseAddress does.
 *
 * `instances` is the set of configured platform instance ids — the only way to know whether a
 * leading `x:` is a platform or part of a channel id. Unqualified input keeps its old meaning, so
 * every `--channel` value that worked before still does.
 */
export function parseTarget(s: string, instances: ReadonlySet<string>): ChannelTarget {
  const i = s.indexOf(TARGET_SEP);
  if (i > 0) {
    const platform = s.slice(0, i);
    if (instances.has(platform)) return { platform, address: parseAddress(s.slice(i + 1)) };
  }
  return { address: parseAddress(s) };
}

/**
 * Whether one config entry (a textual address an operator wrote) selects `a`.
 *
 * Two forms, and the second is the one that had to change: `<chat>/<thread>` names exactly
 * one lane, and a bare `<chat>` names the chat AND every lane inside it.
 *
 * ⚠️ A bare chat entry used to match the chat ROOT ONLY, on the reasoning that each topic is
 * its own conversation. That reasoning holds for identity and breaks for these lists. A
 * Telegram forum has a handful of long-lived topic ids an operator can enumerate; a Feishu
 * **topic-mode group** (话题模式群) mints a fresh `omt_…` for every root message, so no entry
 * an operator can write would ever match — `channels: [oc_xxx]` silenced the bot in the whole
 * group, `freeResponseChannels` could not exempt it, and `ignoredChannels` could not block it,
 * all three without a word in the log. It also disagreed with routing, whose `when.channelId`
 * has always covered a channel's topics (see routing.ts).
 *
 * The trade, stated plainly: "the chat root but not its topics" is no longer expressible.
 * Nothing asked for it, and the previous spelling of it was a trap.
 */
export function addressSelects(entry: string, a: ConversationAddress): boolean {
  if (entry === formatAddress(a)) return true;
  // A lane message additionally answers to its chat; a root message has already been compared.
  return a.thread != null && a.thread !== '' && entry === a.channel;
}

/** Whether any entry of a config list selects `a`. Lists are a handful of entries, so linear is fine. */
export function addressListed(list: readonly string[], a: ConversationAddress): boolean {
  return list.some((entry) => addressSelects(entry, a));
}

/**
 * Field separator for conversation keys. `#` is not `/` (the address separator) on
 * purpose: a key is not an address and must never be parsed as one. Keys are opaque
 * map/JSON keys — the one exception is core/channel-list.ts laneFromLegacyKey, a
 * migration aid for records written before the store kept each conversation's lane,
 * which says there why it is safe.
 */
const KEY_SEP = '#';

/**
 * The conversation key: which conversation an inbound message belongs to.
 *
 * NOTE what is absent: the agent id. It used to lead the key, which meant the agent
 * was part of the conversation's IDENTITY — so `/oc hi` and the plain follow-up after
 * it produced two different keys, two subprocesses and two contexts in one topic. The
 * agent is now a mutable property OF a conversation (see ConversationStore), not part
 * of its name. One topic is one conversation, whoever is currently answering it.
 *
 * Scopes:
 *  - per_thread  — a Telegram topic / Slack thread is its own conversation, and the
 *    channel root is a separate one. The `thread` component is present but empty for
 *    the root, so root and lane can never collide.
 *  - per_channel — every lane inside a channel shares one conversation.
 *  - per_user    — one conversation per sender, wherever they write.
 *  - shared      — one global conversation.
 */
export function conversationKey(scope: SessionScope, ref: ConversationRef): string {
  switch (scope) {
    case 'shared':
      return 'shared';
    case 'per_user':
      return `${ref.platform}${KEY_SEP}u${KEY_SEP}${ref.user}`;
    case 'per_channel':
      return `${ref.platform}${KEY_SEP}${ref.channel}`;
    case 'per_thread':
      return `${ref.platform}${KEY_SEP}${ref.channel}${KEY_SEP}${ref.thread ?? ''}`;
  }
}

/** Human-readable one-liner for logs: `telegram-bot #5865716608/7353`. */
export function describeConversation(ref: ConversationRef): string {
  return `${ref.platform} #${formatAddress(addressOf(ref))}`;
}
