import type { ConversationAddress } from '../core/conversation.js';
import { retryAfterMsOf } from '../core/outbound-errors.js';
import type { OutboundClass, OutboundPacer } from '../core/outbound-pacer.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { MessageRef } from '../types.js';

/**
 * Put every outbound call through one shared per-chat budget (see `core/outbound-pacer.ts`).
 *
 * Applied once, to the daemon's `platforms` map, rather than at the ~38 call sites that write to a
 * chat. That is the whole point: the reply, the tool bubbles, the reactions, the acks, the menus
 * and the agent's own reverse commands are all counted by the platform as ONE stream per chat, so
 * they have to be metered in one place or not at all. Wrapping the map also means a path added
 * later is paced by default instead of by remembering.
 *
 * This is also the one place a platform's "wait N seconds" becomes a lane pause: the profile types
 * the failure (`classifyError` → `RateLimitedError`), this reads the number off it, and the pacer
 * holds every other writer to the same chat for the same time. Without that step each writer backs
 * off alone and the other three keep the flood alive.
 */

/**
 * How one adapter member interacts with the chat budget.
 *
 * - `write` — creates something in the chat. Paced; never coalesced (each call is its own object,
 *   and the caller needs the ref back).
 * - `edit`  — restates an existing message. Paced AND coalesced: two queued edits to one message
 *   collapse to the newer, because only the newest content was ever going to be shown.
 * - `unpaced` — reads, measurement, event registration, lifecycle. Not what floods a chat, and
 *   queueing a blocking read behind a 229 s pause buys nothing.
 *
 * `satisfies Record<keyof PlatformAdapter, …>` makes this exhaustive: a member added to
 * PlatformAdapter fails to compile here until someone decides which of the three it is.
 */
const PACING = {
  sendMessage: 'write',
  editMessage: 'edit',
  replyMessage: 'write',
  sendFile: 'write',
  sendButtons: 'write',
  editButtons: 'edit',
  addReaction: 'write',
  removeReaction: 'write',
  deleteMessage: 'write',
  // createThread / renameThread act on the lane's METADATA, not on the chat's message stream, and
  // the platforms meter them separately. Pacing them would also fight two deliberate decisions:
  // a turn cannot start until createThread returns the address it will write to, and turn-runner
  // keeps renameThread off the render chain precisely so a slow rename never delays a character
  // of the answer (see TurnRunner.buildStreamHandlers onTitle).
  createThread: 'unpaced',
  renameThread: 'unpaced',
  // startTyping is paced but as its own class: it is dropped rather than queued (see laneOf).
  startTyping: 'write',
  // stopTyping runs in a turn's `finally`; making it wait would hold the turn open for a
  // cosmetic indicator that expires by itself anyway.
  stopTyping: 'unpaced',
  fetchHistory: 'unpaced',
  fetchAttachment: 'unpaced',
  // Registers a callback and writes nothing to the chat; the lookup it installs is read while
  // rendering a topic list, which is not traffic the platform meters.
  useWorkdirLookup: 'unpaced',
  useLivenessLookup: 'unpaced',
  useScheduleLookup: 'unpaced',
  // Registers the task panel's list/operations; the page reads them over its own HTTP routes,
  // which are not chat traffic. Nothing here writes to a platform.
  useSchedulePanel: 'unpaced',
  useSkillsPanel: 'unpaced',
  // Ends an agent process on this machine; nothing is written to the chat.
  useIdleReclaim: 'unpaced',
  // Registers a callback, read while drawing an empty topic; writes nothing to the chat.
  useAgentCatalog: 'unpaced',
  // Not chat traffic at all: the one implementor draws it in its own page, and the status board
  // already throttles it. Queueing a status behind a platform's flood pause would only show a
  // stale one later.
  setStatus: 'unpaced',
  // Same: state drawn in the page's own topic list, pushed only at a turn's start and end.
  setActivity: 'unpaced',
  // A read of what the page reported; nothing is sent anywhere.
  seenAt: 'unpaced',
  // Reads of the page's own topic list; nothing is sent anywhere.
  parentOf: 'unpaced',
  childrenOf: 'unpaced',
  // A read of the page's own topic list; nothing is sent anywhere.
  hasThread: 'unpaced',
  measureRendered: 'unpaced',
  registerCommands: 'unpaced',
  onMessage: 'unpaced',
  onButton: 'unpaced',
  onCommand: 'unpaced',
  start: 'unpaced',
  stop: 'unpaced',
  platform: 'unpaced',
  platformType: 'unpaced',
  capabilities: 'unpaced',
} satisfies Record<keyof PlatformAdapter, 'write' | 'edit' | 'unpaced'>;

/** A paced adapter, plus a way to ask for a view of it in a different lane. */
export interface PacedPlatformAdapter extends PlatformAdapter {
  /** This adapter, with its writes submitted under `cls`. See OutboundClass for what that costs. */
  lane(cls: OutboundClass): PlatformAdapter;
}

/**
 * The adapter's writes in a given class.
 *
 * Falls back to the adapter itself when it is not paced, so the hand-written fakes in the daemon
 * tests keep working without every one of them growing a `lane` method.
 */
export function outboundLane(adapter: PlatformAdapter, cls: OutboundClass): PlatformAdapter {
  const paced = adapter as Partial<PacedPlatformAdapter>;
  return typeof paced.lane === 'function' ? paced.lane(cls) : adapter;
}

export function withOutboundPacing(
  adapter: PlatformAdapter,
  pacer: OutboundPacer
): PacedPlatformAdapter {
  const views = new Map<OutboundClass, PlatformAdapter>();
  // A platform with no flood budget of its own meters each lane apart (see paceByLane): the web
  // UI, whose topics would otherwise queue behind each other's streaming.
  const byLane = adapter.capabilities.paceByLane === true;
  // A typing indicator that stays on until stopped is state, not a beat, and a dropped beat is
  // only harmless when the next one replaces it (see typingUntilStopped). So it is not metered —
  // which costs nothing where it applies: the web UI's setTyping writes only when the state flips.
  const typingIsState = adapter.capabilities.typingUntilStopped === true;

  const build = (cls: OutboundClass): PlatformAdapter => {
    const out: Record<string, unknown> = {};
    for (const [name, member] of entriesOf(adapter)) {
      const kind = name === 'startTyping' && typingIsState ? 'unpaced' : (PACING[name as keyof typeof PACING] ?? 'unpaced');
      if (kind === 'unpaced' || typeof member !== 'function') {
        out[name] = typeof member === 'function' ? (member as () => unknown).bind(adapter) : member;
        continue;
      }
      out[name] = (...args: unknown[]): Promise<unknown> => {
        const address = addressOfCall(args);
        // A chat with no address is not a chat we can meter; run it rather than invent a key.
        if (!address) return (member as (...a: unknown[]) => Promise<unknown>).apply(adapter, args);
        const key = `${adapter.platform}:${address.channel}${byLane && address.thread ? `/${address.thread}` : ''}`;
        return pacer.submit({
          key,
          instance: adapter.platform,
          // Typing is never worth queueing: an indicator that arrives after the thing it was
          // announcing is noise, and the platform expires it on its own anyway.
          cls: name === 'startTyping' ? 'typing' : cls,
          // Coalesce edits by the message they restate. Deliberately keyed on the message and not
          // on the caller, so a bubble edited by two paths still collapses to one write.
          ...(kind === 'edit' ? { slot: `edit:${address.channel}:${messageIdOfCall(args)}` } : {}),
          run: async () => {
            try {
              return await (member as (...a: unknown[]) => Promise<unknown>).apply(adapter, args);
            } catch (e) {
              // The platform stated a wait. Hold the whole chat for it — not just this writer,
              // which is the mistake that let four writers take turns re-earning one flood limit.
              const ms = retryAfterMsOf(e);
              if (ms !== undefined) pacer.penalize(key, ms);
              throw e; // the caller still decides what a failure means for its own state
            }
          },
        });
      };
    }
    (out as unknown as PacedPlatformAdapter).lane = laneView;
    return out as unknown as PlatformAdapter;
  };

  const laneView = (cls: OutboundClass): PlatformAdapter => {
    let view = views.get(cls);
    if (!view) {
      view = build(cls);
      views.set(cls, view);
    }
    return view;
  };

  return laneView('reply') as PacedPlatformAdapter;
}

/** Own AND inherited enumerable members: an adapter may be a class instance, not a literal. */
function entriesOf(adapter: PlatformAdapter): Array<[string, unknown]> {
  const names = new Set<string>();
  for (let o: object | null = adapter; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') names.add(k);
  }
  return [...names].map((k) => [k, (adapter as unknown as Record<string, unknown>)[k]]);
}

/**
 * The chat a call targets — from a `ConversationAddress` argument or from a `MessageRef`'s.
 *
 * The THREAD is deliberately not part of the key by default (see PaceJob.key): a Telegram forum
 * topic shares its parent chat's flood budget, so giving each topic its own allowance would hand a
 * busy forum N times the traffic the platform is willing to take and reproduce the flood one
 * level down. Only a platform that declares `paceByLane` gets it added.
 */
function addressOfCall(args: unknown[]): ConversationAddress | undefined {
  const first = args[0] as Partial<ConversationAddress & MessageRef> | undefined;
  if (!first || typeof first !== 'object') return undefined;
  if (typeof first.channel === 'string') return first as ConversationAddress;
  if (first.address && typeof first.address.channel === 'string') return first.address;
  return undefined;
}

/** The message an edit restates, for the coalescing slot. */
function messageIdOfCall(args: unknown[]): string {
  const first = args[0] as Partial<MessageRef> | undefined;
  return typeof first?.messageId === 'string' ? first.messageId : '?';
}
