/**
 * The built-in web UI: a `PlatformAdapter` that is a browser page instead of a chat app.
 *
 * ── Why this does not go through the profile seam ─────────────────────────────
 * Every other platform here is assembled by `satori-core.ts` from a `PlatformProfile`, and
 * that assembly is built around a Satori `Bot`: it resolves one, calls `bot.sendMessage`,
 * normalises a `Session` into an `InboundMessage`, and delegates the platform's differences
 * to the profile. There is no bot here, no gateway and no upstream service — the daemon owns
 * both ends of this conversation. Forced through the seam, every profile method would be a
 * stub around state `room.ts` holds anyway, and `satori-core` would be carrying a `Context`
 * that installs nothing.
 *
 * So it implements `PlatformAdapter` directly, which is all the daemon ever sees — a sibling
 * implementation rather than a pretend member of a protocol it does not speak.
 *
 * ── What that costs, and where it is paid back ───────────────────────────────
 * Bypassing `satori-core` means bypassing what it does for EVERY platform, and the failure
 * mode of forgetting one is silence. Each is re-implemented with a comment naming it: the
 * listen allowlist (`chat.channels`) and the `[in]` log line in `room.ts`, connection logging
 * in `room.ts` and `server.ts`, `measureRendered` and the typed `MessageNotEditableError`
 * below.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { configDir } from '../../config/load.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { MessageRef, SettingsScreen, SlashCommandSpec } from '../../types.js';
import { MESSAGE_KINDS, type MessageKind, type PlatformAdapter, type SendOptions } from '../adapter.js';
import { renderWebMarkdown } from '../web-markdown.js';
import { WebAuth, fileSessionStore } from './auth.js';
import { readableKind } from './reading.js';
import {
  CHANNEL,
  inlineImageType,
  TopicStore,
  WebRoom,
  webMessageHtml,
  type Kept,
  type TranscriptStore,
  type UploadStore,
  type WebuiInstance,
} from './room.js';
import { createWebServer, type WebServer } from './server.js';
import { WebSso } from './sso.js';
import { TerminalSessions } from './terminal-sessions.js';
import { WebPush } from './webpush.js';

export { WebRoom, TopicStore, type Topic, type WebuiInstance } from './room.js';

/**
 * What this platform can do, declared honestly.
 *
 * Almost everything is true, which is unusual in this directory and is simply what a browser
 * is: it can redraw a message, show a button, strike one out, and stop a typing indicator on
 * command instead of waiting for it to expire.
 */
const CAPABILITIES: PlatformAdapter['capabilities'] = {
  editMessage: true,
  /**
   * Declared for the record; nothing in the daemon reads either. `addReaction` / `startTyping`
   * are called unconditionally and swallowed on failure, so the obligation these two flags
   * describe is really "these methods must be safe to call", which they are.
   */
  reaction: true,
  typing: true,
  reply: true,
  /**
   * Topics. Each is a lane on the one channel, so each is its own conversation with its own
   * agent session — the Telegram-forum shape, in a browser. `createThread` opens one, which
   * also means the agent can open one for itself.
   */
  thread: true,
  /** A topic is made from nothing here, so a scheduled run with no message can open one. */
  standaloneThread: true,
  /**
   * And they can be named, which is the other half of that shape: the harness summarises what
   * a topic turned out to be about and the switcher shows it. This works only because a topic
   * IS a lane — `retitleLane` refuses any address without one, so the channel-per-topic
   * alternative would have left this permanently inert.
   */
  renameThread: true,
  buttons: true,
  editButtons: true,
  /**
   * `/setting` is a screen here, not a grid: the page has the width to put a setting's label and
   * its whole value on separate lines, group the rows, and mark the current value. The daemon
   * attaches the structured form to the menu message when this is declared (adapter.ts
   * `settingsScreen`); every chat platform keeps the button grid it has always had.
   */
  settingsScreen: true,
  /**
   * The most core allows, and twice what the chat platforms declare. It was their 12, so that
   * which client someone read from did not change how many directories `/cd` offered — until the
   * operator asked this one for more (2026-10-31). The page draws a menu as a grid (page.ts
   * menu()), several directories a row on a desktop and two on a phone, where a chat app gives a
   * button a row or a slot of its own; so 24 costs fewer rows here than 12 does on Telegram, and
   * a page of long model ids is still one phone screen (core/paging.ts PAGE_SIZE_MAX).
   */
  menuPageSize: 24,
  /**
   * Received, not registered in the platform's own UI — the same shape as Telegram, where a
   * slash command arrives as an ordinary message. `registerCommands` here only hands the page
   * the vocabulary for its autocomplete; invoking one sends plain text, which `route()`
   * intercepts exactly as it does anywhere else. So there is no interaction to close out.
   */
  slashCommands: true,
  slashNeedsAck: false,
  canRegisterSlashAtRuntime: true,
  /**
   * Each topic gets its own write budget. Nothing at this end counts writes, and every topic is a
   * lane on the one channel — so on the channel's shared budget a menu tap in a quiet topic queued
   * behind every other topic's streaming, seconds at a time. See the field in adapter.ts.
   */
  paceByLane: true,
  /**
   * Typing here is the topic's dot, its "running" label and its Stop button — a state `room.ts`
   * holds until `stopTyping`, not an indicator that fades. So the pacer must not drop a start the
   * way it drops a chat app's beat. See the field in adapter.ts.
   */
  typingUntilStopped: true,
  /**
   * Not a platform limit — a browser has none. It is a ceiling on how large one message may
   * grow before the writer seals it and starts another, and it exists because a streaming edit
   * re-renders the whole body: without a bound, one runaway reply becomes an unbounded DOM
   * node. 20k characters is far past any real answer, so nothing is ever split in practice.
   */
  maxMessageLength: 20_000,
  /**
   * The whole command, near enough, where a chat app gets the operator's 40 characters: the page
   * folds every tool line to one row and opens it on a click, so a long one costs nothing until
   * someone asks to read it. Bounded rather than unlimited because each line is re-sent on every
   * edit of its bubble, and a heredoc'd script can run to pages — past this it keeps its `…`.
   */
  toolPreviewLimit: 2_000,
  // maxEditsPerMessage is deliberately absent: nothing here refuses an edit after N of them.
};

/**
 * Build the adapter the daemon drives.
 *
 * `start()` binds the port — not this function. `createPlatformAdapters` runs in
 * `commands/start.ts` well before `Daemon.run()` registers the inbound handlers, so a server
 * listening from the factory would accept a message in that window and drop it into a null
 * handler with nothing logged.
 */
export function createWebuiAdapter(instance: WebuiInstance): PlatformAdapter {
  // Per instance rather than one shared file: two web UIs on two ports are two deployments,
  // and merging their topic lists would put one's rooms in the other's switcher.
  const topics = new TopicStore(path.join(configDir(), `webui-topics-${instance.id}.json`));
  // The page is never without a room to be in, including on a brand-new install.
  topics.current();
  const room = new WebRoom(instance, topics);
  room.useUploads(diskUploadStore(path.join(configDir(), `webui-uploads-${instance.id}`)));
  // Before anything can attach: a page that connects first would be handed an empty topic.
  room.useTranscripts(diskTranscriptStore(path.join(configDir(), `webui-transcripts-${instance.id}`)));
  // Owned here because both ends of it are wired here: the server feeds it (a pane attaches on
  // every proxied handshake) and the room reads it (the switcher's terminal marker). Given the
  // command up front, since whether a session can be ended at all decides whether the page
  // renders a close button.
  const sessions = new TerminalSessions(instance.terminal.endCommand);
  room.useTerminalSessions(sessions);
  // Push notifications to devices whose page is closed (webpush.ts). Beside the other per-instance
  // state; the key is made on first start and kept, since every device's subscription names it.
  const push = new WebPush(path.join(configDir(), `webui-push-${instance.id}`));
  room.useNotifier((notice) => {
    if (push.count > 0) void push.notifyAll(notice);
  });
  const server = createWebServer(
    room,
    // Beside the topic file, per instance for the same reason. Persisted so that an upgrade —
    // which in a container is a restart — does not ask for the secret again; see `auth.ts`.
    new WebAuth({
      token: instance.token,
      store: fileSessionStore(path.join(configDir(), `webui-sessions-${instance.id}.json`)),
    }),
    instance,
    {
      enabled: instance.terminal.enabled,
      // Beside the topic file above, and for the same reason: this is the directory both ends
      // of the terminal already share. The daemon's config lives here, so in a container it is
      // the bind mount, which is where ttyd can reach it without a second volume.
      socket: instance.terminal.socket ?? path.join(configDir(), `webui-term-${instance.id}.sock`),
      sessions,
    },
    // Absent unless configured, and that absence is the whole of "SSO is off": the server has
    // no fallback path that half-trusts a header when there is nothing to verify it against.
    instance.sso ? new WebSso(instance.sso) : undefined,
    push
  );
  return { ...describe(instance), ...outbound(room, instance), ...lifecycle(room, server) };
}

function describe(instance: WebuiInstance): Pick<PlatformAdapter, 'platform' | 'platformType' | 'capabilities'> {
  return { platform: instance.id, platformType: 'webui', capabilities: CAPABILITIES };
}

/**
 * The operator's own pictures and the agent's sent files, on disk, so the page can serve them from a
 * copy of its own (room.ts `UploadStore`).
 *
 * Emptied when the adapter is built. The only thing that names these files is the download table,
 * which lives in memory, so after a restart nothing can reach them and they would only pile up.
 * Per instance and beside its topic file, for the reason that file is per instance.
 *
 * The browser's file name is never part of the path, only its extension — which `inlineImageType`
 * has already matched against its closed list before anything reaches here. A copy of the agent's
 * file takes no part of its name at all: the download is served under `Download.name`, not this.
 */
export function diskUploadStore(dir: string): UploadStore {
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = (what: string) => (e: unknown) =>
    console.error(`[webui] could not ${what}: ${e instanceof Error ? e.message : e}`);
  return {
    save(name, base64) {
      const file = path.join(dir, `${randomUUID()}${/\.[a-z0-9]+$/i.exec(name)?.[0]?.toLowerCase() ?? ''}`);
      // Decoded inside the chain, not before it, so a large screenshot is not turned back into bytes
      // on the request that is still waiting for its 202.
      const ready = fs.promises
        .mkdir(dir, { recursive: true, mode: 0o700 })
        .then(() => fs.promises.writeFile(file, Buffer.from(base64, 'base64'), { mode: 0o600 }))
        .catch(failed(`keep ${name} for the transcript`));
      return { path: file, ready };
    },
    async copy(source) {
      const file = path.join(dir, randomUUID());
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await fs.promises.copyFile(source, file);
        // copyFile gives the copy the source's mode, and the agent's file may well be 0644.
        await fs.promises.chmod(file, 0o600);
      } catch (e) {
        // Half a file is worse than none: nothing would ever name it to delete it.
        await fs.promises.rm(file, { force: true });
        throw e;
      }
      return file;
    },
    discard(file) {
      fs.promises.rm(file, { force: true }).catch(failed(`delete ${file}`));
    },
  };
}

/**
 * Every topic's transcript, on disk (room.ts `TranscriptStore`): one `<topic id>.json` per topic.
 *
 * `0600` in a `0700` directory, like the uploads beside it. A transcript is agent output, which
 * carries the bytes of whatever the agent read; that is no wider than the agent's own session files,
 * which hold all of it already, but it is not something to leave world-readable either. Written to a
 * temporary name and renamed, so a daemon killed mid-write leaves the previous copy rather than
 * half of a new one.
 *
 * ── Two ways to write, and why ──────────────────────────────────────────────
 * The routine write (`save`, every few seconds while a topic changes) must not hold the event loop:
 * it used to be one `JSON.stringify` and one `writeFileSync` of the whole ring, and a 1000-message
 * topic (3 MB) held it for 28 ms at the median and 91 ms at worst (measured 2026-11-07) — every
 * stream, IPC call and pacer timer in the daemon waiting behind it, every three seconds, for as long
 * as a long topic streamed. So it serialises a message at a time and writes each `BATCH_BYTES` of
 * them to the file as it goes (`writeOut`), the event loop running between batches. Not one string
 * written at the end: the 3 MB join and its 3 MB encoding were a stall of their own, with the
 * collection after them. The rename stays synchronous, for the ordering below.
 *
 * The exit write (`saveNow`) stays synchronous, because `dispose` runs on the way out and a promise
 * there would be abandoned by the exit it is racing.
 *
 * Writes to one topic go one at a time, and only the newest waiting one is written: a write queued
 * behind another that has since been superseded is skipped. A `saveNow` or `drop` moves the topic's
 * fence, and an async write that finds the fence moved when it is about to rename throws its
 * temporary file away instead — otherwise a write begun before the exit write, or before a delete,
 * could land after it and put an older transcript, or a deleted one, back.
 */
export function diskTranscriptStore(dir: string): TranscriptStore {
  const file = (topicId: string): string => path.join(dir, `${topicId}.json`);
  const failed = (what: string, e: unknown): void =>
    console.error(`[webui] could not ${what}: ${e instanceof Error ? e.message : e}`);
  // Three per-topic records, each held only while a write of that topic is queued or under way —
  // topics come and go by the thousand over a daemon's life (a scheduled run opens one each time),
  // and a number kept for every id ever written would be a leak of its own.
  /** The end of each topic's queue of writes. */
  const tails = new Map<string, Promise<void>>();
  /** The newest `save` asked for, so an older one still queued can step aside. */
  const latest = new Map<string, number>();
  /** Moved by a `saveNow` or `drop` that finds a write queued or under way; see above. */
  const fences = new Map<string, number>();
  let asked = 0;
  const fenceOf = (topicId: string): number => fences.get(topicId) ?? 0;
  const moveFence = (topicId: string): void => {
    if (tails.has(topicId)) fences.set(topicId, fenceOf(topicId) + 1);
  };

  const write = async (topicId: string, messages: Kept[], mine: number, fence: number): Promise<void> => {
    if (latest.get(topicId) !== mine || fenceOf(topicId) !== fence) return;
    // Its own name, not `saveNow`'s: the exit write can run while this one's bytes are still going
    // out on the thread pool, and two writers on one file would interleave.
    const tmp = `${file(topicId)}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeOut(tmp, messages);
      if (fenceOf(topicId) !== fence) {
        await fs.promises.rm(tmp, { force: true });
        return;
      }
      fs.renameSync(tmp, file(topicId));
    } catch (e) {
      failed(`keep the transcript of ${topicId}`, e);
    }
  };

  return {
    load() {
      const out = new Map<string, Kept[]>();
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return out;
      }
      for (const name of names) {
        // A write the last run was killed in the middle of. Nothing is writing yet — this runs
        // before anything can attach — so it is nobody's.
        if (name.endsWith('.tmp')) {
          try {
            fs.rmSync(path.join(dir, name), { force: true });
          } catch {
            /* left for the next start; it is never read */
          }
          continue;
        }
        const m = /^([0-9a-f]{8})\.json$/.exec(name);
        if (!m?.[1]) continue;
        try {
          const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          const kept = Array.isArray(raw) ? raw.map(parseKept).filter((k): k is Kept => k !== null) : [];
          if (kept.length) out.set(m[1], kept);
        } catch (e) {
          failed(`read the kept transcript ${name}`, e);
        }
      }
      return out;
    },
    save(topicId, messages) {
      const mine = ++asked;
      latest.set(topicId, mine);
      const fence = fenceOf(topicId);
      const next = (tails.get(topicId) ?? Promise.resolve()).then(() => write(topicId, messages, mine, fence));
      tails.set(topicId, next);
      void next.finally(() => {
        if (tails.get(topicId) !== next) return;
        tails.delete(topicId);
        latest.delete(topicId);
        fences.delete(topicId);
      });
      return next;
    },
    saveNow(topicId, messages) {
      moveFence(topicId);
      const tmp = `${file(topicId)}.exit.tmp`;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, JSON.stringify(messages), { mode: 0o600 });
        fs.renameSync(tmp, file(topicId));
      } catch (e) {
        failed(`keep the transcript of ${topicId}`, e);
      }
    },
    drop(topicId) {
      moveFence(topicId);
      try {
        fs.rmSync(file(topicId), { force: true });
      } catch (e) {
        failed(`forget the transcript of ${topicId}`, e);
      }
    },
  };
}

/**
 * How much JSON `writeOut` makes before it hands it to the file and lets the event loop run. At the
 * ~70 MB/s `JSON.stringify` manages on a transcript, a few milliseconds of work.
 */
const BATCH_BYTES = 256 * 1024;

/**
 * Write `JSON.stringify(messages)`, byte for byte, to `tmp` (created `0600`), without holding the
 * event loop for all of it: one message at a time, a batch of them per write. Safe across the awaits
 * because what it is handed is a snapshot (`WebRoom.writeKept`) of message objects the room
 * replaces rather than edits.
 */
async function writeOut(tmp: string, messages: Kept[]): Promise<void> {
  const out = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await out.write('[');
    let batch: string[] = [];
    let size = 0;
    let comma = '';
    for (const k of messages) {
      const part = JSON.stringify(k);
      batch.push(part);
      size += part.length;
      if (size < BATCH_BYTES) continue;
      await out.write(comma + batch.join(','));
      comma = ',';
      batch = [];
      size = 0;
    }
    await out.write(`${batch.length ? comma + batch.join(',') : ''}]`);
  } finally {
    await out.close();
  }
}

/**
 * One kept message, or null. Rebuilt field by field rather than trusted whole: the file is this
 * daemon's own and `0600`, but what comes out of it goes straight to the page as markup, so only
 * the fields `WebMessage` has, of the types it has them, are carried across.
 */
function parseKept(value: unknown): Kept | null {
  if (!value || typeof value !== 'object') return null;
  const { msg, text } = value as { msg?: Record<string, unknown>; text?: unknown };
  if (!msg || typeof text !== 'string') return null;
  const { id, own, html, at, g, reactions, quote, file, nonce, kind } = msg;
  if (typeof id !== 'string' || typeof html !== 'string' || typeof at !== 'number' || typeof g !== 'number') return null;
  const k = keptKind(kind);
  const q = quote as { html?: unknown } | undefined;
  const f = file as { name?: unknown; url?: unknown; image?: unknown } | undefined;
  return {
    text,
    msg: {
      id,
      own: own === true,
      html,
      at,
      g,
      buttons: [],
      reactions: Array.isArray(reactions) ? reactions.filter((r): r is string => typeof r === 'string') : [],
      ...(typeof q?.html === 'string' ? { quote: { html: q.html } } : {}),
      // Not `view`, for the reason `buttons` is emptied: the reader is answered from the download
      // table, which died with the run that minted the token, so it could only open onto a 404.
      ...(typeof f?.name === 'string' && typeof f.url === 'string'
        ? { file: { name: f.name, url: f.url, ...(f.image === true ? { image: true } : {}) } }
        : {}),
      ...(typeof nonce === 'string' ? { nonce } : {}),
      // The kinds the page draws differently, restored across a restart so the marking — and a
      // report's folding — survives a reload exactly as it was.
      ...(k ? { kind: k } : {}),
    },
  };
}

/**
 * A `kind` this build knows, or nothing: an older file may hold a value from a future one. The
 * list lives beside `MessageKind` in adapter.ts, so this cannot carry a second copy of the union.
 */
function keptKind(kind: unknown): MessageKind | undefined {
  return (MESSAGE_KINDS as readonly unknown[]).includes(kind) ? (kind as MessageKind) : undefined;
}

type Outbound = Pick<
  PlatformAdapter,
  | 'sendMessage'
  | 'editMessage'
  | 'deleteMessage'
  | 'sendFile'
  | 'replyMessage'
  | 'sendButtons'
  | 'editButtons'
  | 'addReaction'
  | 'removeReaction'
  | 'startTyping'
  | 'stopTyping'
  | 'setStatus'
  | 'setActivity'
  | 'seenAt'
  | 'parentOf'
  | 'childrenOf'
  | 'hasThread'
  | 'createThread'
  | 'renameThread'
  | 'measureRendered'
  | 'fetchHistory'
>;

/**
 * Whether an address names a topic this store still has — the adapter's `hasThread`.
 *
 * Its own function because the room behind the adapter is not part of its public shape: this is
 * the only way to test the question against a real room, and a daily run's decision to reopen a
 * deleted topic is worth testing (room.test.ts).
 */
export function hasTopic(topics: { has(id: string): boolean }, address: ConversationAddress): boolean {
  return address.channel === CHANNEL && address.thread !== undefined && topics.has(address.thread);
}

function outbound(room: WebRoom, instance: WebuiInstance): Outbound {
  /**
   * The topic an address names.
   *
   * Every outbound call has to say which room it is for, and the two ways of getting that
   * wrong both deserve an error rather than a guess: a channel that is not this instance's
   * (a `--channel` override on a reverse command) and a topic that no longer exists. Posting
   * either into "the only room there is" would be the wrong kind of helpful — there is now
   * more than one.
   */
  const topicOf = (address: ConversationAddress, op: string): string => {
    const where = `${address.channel}${address.thread ? `/${address.thread}` : ''}`;
    if (address.channel !== CHANNEL || !address.thread) {
      throw new Error(`[webui] ${op}: "${instance.id}" addresses topics as ${CHANNEL}/<topic id>, not ${where}`);
    }
    if (!room.topics.has(address.thread)) {
      throw new Error(`[webui] ${op}: no such topic ${where}`);
    }
    return address.thread;
  };
  const ref = (topic: string, id: string): MessageRef => ({
    address: { channel: CHANNEL, thread: topic },
    messageId: id,
  });

  return {
    async sendMessage(address, text, opts) {
      const topic = topicOf(address, 'sendMessage');
      const kind = opts?.kind;
      const part = { own: false, html: webMessageHtml(kind, text), ...(kind ? { kind } : {}) };
      return ref(topic, room.post(topic, part, text).id);
    },
    async editMessage(r, text) {
      room.revise(topicOf(r.address, 'editMessage'), r.messageId, text);
    },
    async deleteMessage(r) {
      room.remove(topicOf(r.address, 'deleteMessage'), r.messageId);
    },
    async sendFile(address, file) {
      const topic = topicOf(address, 'sendFile');
      const name = file.name ?? file.path.split('/').pop() ?? 'file';
      // Copied before this returns, because the path may not outlive the call — see `publishCopy`.
      const url = await room.publishCopy(file.path, name);
      const caption = file.caption ?? '';
      // A screenshot the agent just took is worth more on screen than in the downloads folder,
      // so an image says so and the page draws it. Everything else stays a link, including the
      // formats that only *look* like images — see `inlineImageType` for which and why. A report
      // or a log gets a reader as well as the link: `readableKind` is that list, and `view` the
      // URL that renders one (see `reading.ts`).
      const image = inlineImageType(name) !== undefined;
      const view = readableKind(name) !== undefined ? room.viewUrl(url) : undefined;
      return ref(
        topic,
        room.post(
          topic,
          {
            own: false,
            html: renderWebMarkdown(caption),
            file: { name, url, ...(image ? { image } : {}), ...(view ? { view } : {}) },
          },
          caption
        ).id
      );
    },
    async replyMessage(r, text) {
      // A quote of the message being answered, which is all "native reply" can mean on a page
      // whose topics are flat: the reader sees what it is about without scrolling.
      const topic = topicOf(r.address, 'replyMessage');
      const quote = room.htmlOf(topic, r.messageId);
      return ref(topic, room.post(topic, { own: false, html: renderWebMarkdown(text), quote: { html: quote } }, text).id);
    },
    async sendButtons(address, text, buttons, screen?: SettingsScreen, opts?: SendOptions) {
      const topic = topicOf(address, 'sendButtons');
      const kind = opts?.kind;
      return ref(
        topic,
        room.post(
          topic,
          {
            own: false,
            // The same rule as a plain send: a report sent with buttons is still line-based, and
            // rendering it as markdown would leave the page a "Show all" with nothing to open.
            html: webMessageHtml(kind, text),
            buttons,
            ...(screen ? { settings: screen } : {}),
            ...(kind ? { kind } : {}),
          },
          text
        ).id
      );
    },
    async editButtons(r, text, buttons, screen?: SettingsScreen) {
      room.revise(topicOf(r.address, 'editButtons'), r.messageId, text, buttons, screen);
    },
    async addReaction(r, emoji) {
      room.react(topicOf(r.address, 'addReaction'), r.messageId, emoji, true);
    },
    async removeReaction(r, emoji) {
      room.react(topicOf(r.address, 'removeReaction'), r.messageId, emoji, false);
    },
    async startTyping(address) {
      room.setTyping(topicOf(address, 'startTyping'), true);
    },
    async stopTyping(address) {
      room.setTyping(topicOf(address, 'stopTyping'), false);
    },
    /**
     * The strip above the composer. The only platform with one, because it is the only one that
     * draws its own chrome: a chat app's composer belongs to the chat app.
     */
    setStatus(address, status) {
      room.setStatus(topicOf(address, 'setStatus'), status);
    },
    /** How a topic's last turn ended: what its row and the Needs-you list say about it. */
    setActivity(address, activity) {
      room.setActivity(topicOf(address, 'setActivity'), activity);
    },
    /** Read, so a topic that is gone answers "never seen" rather than throwing. */
    seenAt(address) {
      return address.channel === CHANNEL && address.thread ? room.seenAt(address.thread) : undefined;
    },
    /** Topic.parent, read the same forgiving way: asked about conversations that may have gone. */
    parentOf(address) {
      const parent = address.channel === CHANNEL && address.thread ? room.parentOf(address.thread) : undefined;
      return parent ? { channel: CHANNEL, thread: parent } : undefined;
    },
    childrenOf(address) {
      return address.channel === CHANNEL && address.thread
        ? room.childrenOf(address.thread).map((thread) => ({ channel: CHANNEL, thread }))
        : [];
    },
    /** Asked before a daily-session run rejoins yesterday's topic: a deleted one must be reopened. */
    hasThread(address) {
      return hasTopic(room.topics, address);
    },
    /**
     * Open a topic.
     *
     * Reached from the reverse command, so an agent can file a side errand into a room of its
     * own rather than into the middle of the conversation that asked for it. The daemon's own
     * `autoThread: 'perTurn'` never gets here — that path requires `kind: 'group'` and this
     * platform reports `'direct'`.
     */
    async createThread(_r, name, opts) {
      const under = opts?.under?.channel === CHANNEL ? opts.under.thread : undefined;
      const topic = room.createTopic(name, under, { scheduled: opts?.scheduled === true });
      return { address: { channel: CHANNEL, thread: topic.id } };
    },
    /** Name a topic. The string is `formatLaneTitle`'s `[agent] subject`. */
    async renameThread(address, name) {
      room.renameTopic(topicOf(address, 'renameThread'), name);
    },
    /**
     * Identity, and it has to be: `maxMessageLength` counts the raw markdown the writer is
     * chunking, not the html this adapter renders it into. Measuring the html would make a
     * fenced code block read three to five times its real size and chop replies at a fraction
     * of the stated limit for no reason.
     */
    measureRendered(text) {
      return text.length;
    },
    async fetchHistory(address, opts) {
      return room.history(topicOf(address, 'fetchHistory'), opts);
    },
  };
}

function lifecycle(
  room: WebRoom,
  server: WebServer
): Pick<
  PlatformAdapter,
  | 'onMessage'
  | 'onButton'
  | 'onCommand'
  | 'useWorkdirLookup'
  | 'useLivenessLookup'
  | 'useScheduleLookup'
  | 'useSchedulePanel'
  | 'useSkillsPanel'
  | 'useReviewPanel'
  | 'useIdleReclaim'
  | 'useTopicKill'
  | 'useAgentCatalog'
  | 'useModelPicker'
  | 'registerCommands'
  | 'start'
  | 'stop'
> {
  return {
    onMessage: (handler) => room.onMessage(handler),
    onButton: (handler) => room.onButton(handler),
    /**
     * The one platform that implements this, because it is the one with somewhere to put the
     * answer: the topic switcher's rows have a second line, and without this several topics
     * open on different projects are indistinguishable there.
     */
    useWorkdirLookup: (lookup) => room.useWorkdirLookup(lookup),
    /**
     * Likewise the only implementor: a chat app's conversation list is the platform's, and this
     * page draws its own — so it is the only one that can show that a topic which stopped talking
     * an hour ago still has an agent behind it.
     */
    useLivenessLookup: (lookup) => room.useLivenessLookup(lookup),
    /**
     * The only implementor because it is the only platform that throws topics away by itself:
     * a chat app's list is the platform's, and this one evicts past its cap. Read only then.
     */
    useScheduleLookup: (lookup) => room.useScheduleLookup(lookup),
    /**
     * Likewise the only implementor, and for a different reason: a chat app manages tasks through
     * `/setting schedule`, whose menu is a message. This page has a column to put them in, so the
     * daemon hands it the list and the four operations instead of a rendered menu.
     */
    useSchedulePanel: (panel) => room.useSchedulePanel(panel),
    /**
     * Likewise the only implementor, and for the same kind of reason: `talkcode skills` is how a
     * chat app manages these, and its answer is a message. This page has room for a file list, an
     * editor and a history, so the daemon hands it the store's operations instead of a transcript
     * of them.
     */
    useSkillsPanel: (panel) => room.useSkillsPanel(panel),
    /**
     * The only implementor, for the same kind of reason again: a chat app already gets the one line
     * a review posts when it changed a skill, and nothing for the reviews that changed nothing.
     * This page has a column where the whole history can be read, including the quiet ones.
     */
    useReviewPanel: (panel) => room.useReviewPanel(panel),
    /**
     * The only implementor because it is the only platform that lists its conversations' agents
     * (the dots above) and so the only one with somewhere to offer "close the idle ones".
     */
    useIdleReclaim: (reclaim) => room.useIdleReclaim(reclaim),
    /**
     * The broader half of the same seam: the row menu's "End agent" ends one topic and every topic
     * its agent opened, mid-turn if that is what the person confirmed. See WebRoom.killTopic.
     */
    useTopicKill: (kill) => room.useTopicKill(kill),
    /**
     * The only implementor because a new topic here is a blank page, with room to lay out every
     * agent as one tap — where a chat app has a message box and the `/agent` menu's two levels.
     */
    useAgentCatalog: (lookup) => room.useAgentCatalog(lookup),
    /**
     * The only implementor because it is the only platform with a status line to put a switch
     * in: a chat app has `/model` and its menu, which is a message.
     */
    useModelPicker: (picker) => room.useModelPicker(picker),
    /**
     * Accepted and never called.
     *
     * A slash command reaches this platform as an ordinary message (see `slashCommands`
     * above), so there is no interaction event to normalise. The registration still has to be
     * accepted: the daemon wires all three handlers on every adapter before starting it, and
     * an adapter that refused one would fail `Daemon.run()`.
     */
    onCommand: () => {},
    async registerCommands(cmds: SlashCommandSpec[]) {
      room.setCommands(cmds);
    },
    start: () => server.start(),
    stop: async () => {
      // Send whatever is being held before the sockets go, so a turn that ended just as the
      // daemon was asked to stop is not left with its last edit in a queue nobody will run.
      room.dispose();
      await server.stop();
    },
  };
}
