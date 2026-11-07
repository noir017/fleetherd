/**
 * The wire between the browser page and the web UI server.
 *
 * Split out from `server.ts` for the same reason `ipc/protocol.ts` is split out from
 * `ipc/server.ts`: this is a trust boundary, and a trust boundary is worth reading on its
 * own. Everything arriving from the page is untrusted — the page is served over a port that
 * config binds to `0.0.0.0` by default, and behind it sits an agent with full tool access.
 *
 * So every inbound body is validated by a `.strict()` zod schema and never cast. `.strict()`
 * matters as much as the field types: it rejects unknown keys outright, which keeps the
 * shape the server reasons about equal to the shape it declared, forever.
 *
 * The OUTBOUND direction has types but no schemas, and that asymmetry is deliberate: those
 * objects are constructed by this process, so validating them would only assert that the
 * code did what it says. There is nothing to distrust in that direction.
 */
import { z } from 'zod';

import type { ButtonSpec, MessageKind } from '../adapter.js';
import type { AgentCatalog, AgentStatus, SettingsScreen, SlashCommandSpec } from '../../types.js';
import { MAX_TOPICS, type Topic } from './topics.js';

/**
 * Hard ceiling on one request body.
 *
 * Sized against `EXPERIENCE.attachments.maxDownloadBytes` (25 MiB — `config/schema.ts`)
 * plus base64's ~4/3 expansion and room for the JSON envelope. Deliberately duplicated as a
 * constant rather than read from the config: an adapter only ever receives its own
 * `platforms.<id>` entry, never the whole `Config` (see `platform/README.md`), and reaching
 * for the rest of it to avoid one documented number would break that seam for nothing.
 */
export const MAX_BODY_BYTES = 36 * 1024 * 1024;

/** Longest message the page may submit. Generous; the point is only to bound the buffer. */
const MAX_TEXT_CHARS = 200_000;

/** One file the page attached to a message, as base64 — see the adapter for why base64. */
const UploadSchema = z
  .object({
    name: z.string().min(1).max(255),
    /** Best-effort from the browser; `''` when it could not tell, which the ingest handles. */
    mime: z.string().max(255),
    /** base64, no data: prefix — the adapter builds the URL so the page cannot pick a scheme. */
    data: z.string().max(MAX_BODY_BYTES),
  })
  .strict();

export const LoginRequestSchema = z.object({ token: z.string().min(1).max(4096) }).strict();

/**
 * Which topic a request is about.
 *
 * Shaped, not free text: the id travels on as the lane half of the address `main/<id>`, which
 * `core/conversation.ts` splits on `/` and refuses to see twice. Rejecting the wrong shape here
 * keeps a malformed lane from ever reaching an address.
 */
const TopicId = z.string().regex(/^[0-9a-f]{8}$/, 'not a topic id');

export const SendRequestSchema = z
  .object({
    topic: TopicId,
    text: z.string().max(MAX_TEXT_CHARS),
    files: z.array(UploadSchema).max(10).optional(),
    /**
     * Client-generated, so a retry is safe.
     *
     * The point of the whole weak-network pass: a POST can time out after the server has
     * already accepted it, and a client that retries without this would send the message
     * twice. The daemon's own inbound dedup cannot help — it keys on the message id, and a
     * retry mints a fresh one.
     */
    nonce: z.string().min(1).max(64).optional(),
    /**
     * Deliver this to the daemon without writing it into the conversation.
     *
     * The page's Settings menu sends `/setting` this way: the daemon still has to build the screen
     * from the live config, and it answers with a message of its own, but a page opening must not
     * leave a command nobody typed in the transcript. It still carries a nonce, so a retry after a
     * timeout is deduplicated like any other send.
     *
     * Honoured for a bare `/setting` with no attachments and nothing else — `WebRoom.record` is
     * the judge. Any other text carrying the flag is delivered as an ordinary message; a client
     * must not be able to make something it sent vanish from the conversation by asking.
     */
    quiet: z.boolean().optional(),
  })
  .strict();

export const CreateTopicRequestSchema = z.object({ title: z.string().max(200).optional() }).strict();
export const DeleteTopicRequestSchema = z.object({ topic: TopicId }).strict();
/**
 * Star or unstar a topic. The state is stated rather than toggled, so a retried request — `post`
 * retries on a dropped link — lands where it was meant to instead of flipping back.
 */
export const StarTopicRequestSchema = z.object({ topic: TopicId, starred: z.boolean() }).strict();
/**
 * The operator is looking at a topic. Carries no time: the server stamps its own (WebRoom.markSeen),
 * because what it is compared with — when a turn ended — is the server's time too.
 */
export const SeenRequestSchema = z.object({ topic: TopicId }).strict();
/**
 * A device asking to be notified: `PushSubscription.toJSON()` as the browser makes it. Shape only
 * here; whether the endpoint is a push service this server will POST to is webpush.ts's call
 * (allowedEndpoint), because that is the check that matters and it must not live in two places.
 */
export const PushSubscribeSchema = z
  .object({
    endpoint: z.string().min(1).max(2_048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }).strict(),
  })
  .strict();
export const PushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2_048) }).strict();
/**
 * End one topic's terminal session.
 *
 * Same shape as deleting a topic and deliberately a schema of its own rather than a shared
 * one: the id here is substituted into a command the operator configured, and a schema shared
 * between "forget a row" and "run a program" is one rename away from loosening the second to
 * suit the first.
 */
export const EndTerminalRequestSchema = z.object({ topic: TopicId }).strict();
/**
 * Clear every topic. Takes no fields, and is still a schema rather than an ignored body:
 * `.strict()` is what makes "no fields" mean it, so a request carrying one is refused instead
 * of quietly discarded by the most destructive route here.
 */
export const ClearTopicsRequestSchema = z.object({}).strict();
/**
 * End the agent process of each of these topics that is still idle. The ids are the list the
 * operator was shown and confirmed, so the server acts on exactly those and never on a scan of its
 * own — bounded by the store's cap, since a topic cannot be listed that the store does not hold.
 */
export const CloseIdleRequestSchema = z.object({ topics: z.array(TopicId).min(1).max(MAX_TOPICS) }).strict();

/**
 * One action on one scheduled task.
 *
 * The id is the daemon's own alphabet (`schedule-store.ts` TaskSchema), not the page's: a task id
 * travels into `ScheduleService.op`, and accepting a shape the store cannot hold would only reach
 * a "no such task" one layer later. The action is a closed set rather than a string — `run` starts
 * an unattended process, and the four verbs are the only things the service accepts.
 *
 * No free text anywhere in this body: the panel lists and manages, it does not create. Creation
 * stays in the conversation with the agent, which is the one path that can be asked what a task
 * should do.
 */
const ScheduleTaskId = z.string().regex(/^[a-z0-9]{4,16}$/, 'not a task id');

export const ScheduleOpRequestSchema = z.discriminatedUnion('action', [
  z.object({ id: ScheduleTaskId, action: z.enum(['pause', 'resume', 'run', 'remove']) }).strict(),
  // The tag editor sends the whole set. Its normalized form (trim/lowercase/dedupe, limits) is
  // core/schedule.ts's normalizeTags, reached through ScheduleService.setTags — the same rule the
  // CLI and the native tool use. Here only the shape: an array of strings, bounded.
  z
    .object({ id: ScheduleTaskId, action: z.literal('tags'), tags: z.array(z.string().max(200)).max(50) })
    .strict(),
]);

/**
 * The status line's model switch: this topic, this model. The value is matched by the daemon
 * against the list the agent offers right now (applyModelChoice), exactly as a `/model` menu tap
 * is, so a name the agent does not list is refused there rather than here.
 */
export const ModelChooseRequestSchema = z
  .object({
    topic: TopicId,
    value: z.string().min(1).max(200),
  })
  .strict();

/**
 * One operation on one managed skill.
 *
 * A discriminated union, so each verb carries exactly the fields it needs and a body carrying
 * another verb's field is refused rather than ignored. The bounds here are the request's outer
 * envelope, not the rules: `daemon/skills-store.ts` still validates the name, the path, the
 * frontmatter and the 64 KB / 1 MB limits, and `patch` still refuses a version that is not the
 * one `show` printed. Keeping the numbers in step matters only so a page cannot make the daemon
 * buffer something the store will reject a moment later.
 *
 * There is no `delete`: the store has no hard delete, and the page's "Off" switch is `archive`.
 */
const SkillName = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'not a skill name');
const SkillFilePath = z.string().min(1).max(300);
const SkillMd = z.string().max(64 * 1024);
const SkillExtra = z.string().max(1024 * 1024);
/** A history entry is a commit in the skills repository: what `skillHistory` prints is 12 hex, git takes 7–40. */
const SkillHistoryId = z.string().regex(/^[0-9a-f]{7,40}$/, 'not a history id');

export const SkillOpRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('show'), name: SkillName, file: SkillFilePath.optional() }).strict(),
  z
    .object({
      action: z.literal('create'),
      name: SkillName,
      description: z.string().min(1).max(2000),
      body: SkillMd.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('patch'),
      name: SkillName,
      version: z.string().regex(/^[0-9a-f]{12}$/, 'not a skill version'),
      content: SkillMd,
    })
    .strict(),
  z.object({ action: z.literal('write-file'), name: SkillName, file: SkillFilePath, content: SkillExtra }).strict(),
  z.object({ action: z.literal('remove-file'), name: SkillName, file: SkillFilePath }).strict(),
  z.object({ action: z.literal('archive'), name: SkillName }).strict(),
  z.object({ action: z.literal('restore'), name: SkillName }).strict(),
  z.object({ action: z.literal('pin'), name: SkillName, pinned: z.boolean() }).strict(),
  z.object({ action: z.literal('resident'), name: SkillName, resident: z.boolean() }).strict(),
  z.object({ action: z.literal('revert'), name: SkillName, id: SkillHistoryId }).strict(),
]);

export const ClickRequestSchema = z
  .object({
    topic: TopicId,
    messageId: z.string().min(1).max(256),
    buttonId: z.string().min(1).max(512),
    /**
     * Text typed into the control that was used (a model name on the settings page's value screen,
     * ButtonInteraction.value). Bounded like a value, not a message: what it can become is one
     * scalar in config.yaml, parsed by the same function a typed `/setting` goes through.
     */
    value: z.string().min(1).max(200).optional(),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SendRequest = z.infer<typeof SendRequestSchema>;
export type ClickRequest = z.infer<typeof ClickRequestSchema>;
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;
export type DeleteTopicRequest = z.infer<typeof DeleteTopicRequestSchema>;
export type StarTopicRequest = z.infer<typeof StarTopicRequestSchema>;
export type SeenRequest = z.infer<typeof SeenRequestSchema>;
export type PushSubscribeRequest = z.infer<typeof PushSubscribeSchema>;
export type EndTerminalRequest = z.infer<typeof EndTerminalRequestSchema>;
export type ClearTopicsRequest = z.infer<typeof ClearTopicsRequestSchema>;
export type CloseIdleRequest = z.infer<typeof CloseIdleRequestSchema>;
export type ScheduleOpRequest = z.infer<typeof ScheduleOpRequestSchema>;
export type ModelChooseRequest = z.infer<typeof ModelChooseRequestSchema>;
export type SkillOpRequest = z.infer<typeof SkillOpRequestSchema>;

/**
 * The Reviews tab's one write: dismiss a preference suggestion from the pending list. The text is
 * the suggestion as the list showed it; the store matches it by its normalised form.
 */
export const ReviewOpRequestSchema = z.object({ action: z.literal('dismiss'), text: z.string().min(1).max(2000) }).strict();
export type ReviewOpRequest = z.infer<typeof ReviewOpRequestSchema>;

/**
 * Validate one inbound body against a schema.
 *
 * Returns a result rather than throwing, and names the offending path, so the server answers
 * `400` with something a person debugging the page can act on — the same contract as
 * `parseIpcRequest`.
 */
export function parseBody<T>(
  schema: z.ZodType<T>,
  raw: unknown
): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  const where = first?.path.join('.') || '(root)';
  return { ok: false, error: `malformed request: ${where} ${first?.message ?? ''}`.trim() };
}

/**
 * What the server pushes down the SSE stream.
 *
 * `msg` is an UPSERT, not an append: a message the page already holds under that id is
 * replaced in place. One event kind rather than separate send/edit kinds, because the
 * daemon's streaming writer edits the same message dozens of times per turn and the page
 * would have to treat "edit an id I have never seen" as an append anyway — a reconnect
 * mid-turn produces exactly that. With upsert semantics there is no such case to get wrong.
 */
export type WebEvent =
  /**
   * Full replay of one topic, sent when a client connects without a resumable position.
   *
   * No longer sent on EVERY connect: a stream that reconnects with a `Last-Event-ID` the
   * backlog still covers is caught up with the events it missed instead. Re-sending the whole
   * conversation after every network blip was the single most expensive thing this protocol
   * did on a weak link.
   */
  | {
      t: 'sync';
      topic: string;
      messages: WebMessage[];
      commands: SlashCommandSpec[];
      topics: Topic[];
      /**
       * Which run of the daemon these messages come from — `WebRoom`'s construction time.
       *
       * The page caches transcripts locally and paints them before this sync arrives, so it
       * needs to know whether a cached message and an incoming one that share an id are the
       * same message. They are not, necessarily: `nextId` counts from `w1` per process, and a
       * restart hands the same ids out again. Without a generation to key on, the first reply
       * after a restart would silently overwrite a cached message from before it.
       *
       * Epochs are only ever compared for equality — the page reads no meaning into the value.
       */
      epoch: number;
      /**
       * This topic is older than the running daemon and has nothing left in memory.
       *
       * Set so the page can say WHY it is showing an empty room. Before 2.13.0 only a starred
       * topic's transcript was kept (see `room.ts` `TranscriptStore`), so a restart left rows that
       * open onto nothing — which, rendered faithfully, is indistinguishable from a page that failed
       * to load — and those rows are still there. It also covers the milder case of a topic created
       * before the restart and never spoken in; both are honestly described as "older than this
       * process, nothing here".
       */
      stale?: boolean;
      /** The topic's agent status as of this sync; absent when there is none to show. */
      status?: AgentStatus;
      /**
       * The agents this topic could be given to, for a room with nothing in it yet: the page lays
       * them out in place of the empty transcript, and a tap sends `/agent <id>`. Only on a sync,
       * and only for an empty room — once anything has been said the transcript is the page, and a
       * topic that has started with its agent cannot move (see `PlatformAdapter.useAgentCatalog`).
       */
      agents?: AgentCatalog;
    }
  | { t: 'msg'; msg: WebMessage }
  | { t: 'del'; id: string }
  | { t: 'react'; id: string; emoji: string; on: boolean }
  | { t: 'typing'; on: boolean }
  /**
   * The topic's agent status changed — the strip above the composer. Absent `status` clears it.
   *
   * STATE, not history, and sent like it: never sequenced or kept in the backlog, so a busy turn's
   * stream of them cannot push the messages a reconnect needs out of it. A resumed stream is handed
   * the current one after its replay instead (see `WebRoom.subscribe`) — the only one it needs.
   */
  | { t: 'status'; status?: AgentStatus }
  | { t: 'commands'; commands: SlashCommandSpec[] }
  /**
   * The topic list changed — one was created, renamed, or spoken in.
   *
   * Broadcast to every client regardless of which topic it is watching, because the switcher
   * has to stay current without subscribing to rooms nobody is reading. It is the only event
   * that crosses topics.
   */
  | { t: 'topics'; topics: Topic[] }
  /**
   * The daemon is going away; stop reconnecting.
   *
   * `EventSource` reconnects after ANY close, including a clean one, so without this a tab
   * left open through a restart hammers a dead port on a fixed retry interval — and, worse,
   * looks connected. The page answers it by closing the stream itself and saying so.
   */
  | { t: 'bye' };

/** One message as the page holds it. `html` is already rendered and escaped by web-markdown. */
export interface WebMessage {
  id: string;
  /** Whether the operator wrote it — the page's only styling distinction. */
  own: boolean;
  html: string;
  /** Epoch ms, for the dim timestamp. */
  at: number;
  /**
   * Buttons under the message. REQUIRED, and empty rather than absent when there are none.
   *
   * Because the daemon retires a menu by editing it with an EMPTY list — `retireAsk`,
   * `editModelMenu`, `editWorkdirMenu`, `editSettingsMenu` all call
   * `editButtons(ref, text, [])`. If this were optional and an empty list were sent as
   * "absent", the page's `if (msg.buttons)` would leave the old buttons live under an
   * already-answered question. That is the exact bug `editButtons` exists to fix on Slack and
   * Lark (see `daemon.ts` retireAsk), and it would be a shame to reintroduce it here.
   */
  buttons: ButtonSpec[];
  /**
   * The `/setting` screen this message IS, when the daemon sent one (see `SettingsScreen`).
   *
   * The page draws rows of label and value from these fields instead of reading a button's label
   * and guessing where the value begins — which is what produced `Default model · cc · (harness …`
   * on a phone. Present only on a live settings menu: a message that became history loses its
   * buttons and this with them, for the same reason.
   */
  settings?: SettingsScreen;
  /**
   * This message WAS a settings screen and has been retired in place.
   *
   * The page keeps settings screens out of the transcript — it draws them in a page of their own
   * (see page.ts `takeSettings`) — and a retired one would otherwise come back as a line of text
   * the moment the page is reloaded, or the transcript is re-synced. Set by `room.revise` when a
   * screen is removed without the message becoming another menu: the scheduled-task handover
   * keeps its buttons and IS a menu again, so it is not marked and does show.
   */
  wasSettings?: boolean;
  /** Lifecycle reactions currently on this message (👀 / ✅ / ❌). Empty, never absent, for the same reason. */
  reactions: string[];
  /** Set when the agent used a native reply; rendered as a quote above the body. */
  quote?: { html: string };
  /**
   * Set when the message IS a file the agent sent.
   *
   * `image` says the download URL may be pointed at an `<img>`: the server will serve that one
   * as itself rather than as an octet-stream attachment. The page does not decide this from the
   * name — `room.ts` `inlineImageType` is the single place that answers it, so the tag the page
   * writes and the headers the server sends can never disagree about the same file.
   *
   * `view` is where the page can fetch the file rendered for reading (`server.ts` `view`), set
   * only for a name `reading.ts` `readableKind` accepts — the same arrangement, so the page offers
   * a reader for exactly the files the server will render.
   */
  file?: { name: string; url: string; image?: boolean; view?: string };
  /**
   * The `nonce` of the send this message is the echo of. Only ever set on the operator's own.
   *
   * The page shows a message the moment it is typed, before the POST has been answered, and
   * that local bubble has to be retired when the real one arrives or the transcript shows it
   * twice. Matching on the text would be a guess; the nonce is already round-tripping for
   * idempotency, so it is the exact answer and costs one field.
   */
  nonce?: string;
  /**
   * What the message is beyond its text (SendOptions.kind): a tool-progress bubble, a sub-agent
   * dispatch, or a sub-agent report.
   *
   * The page needs to know rather than sniff the markup. For `tools` it is what puts the "Show
   * all" control under the bubble and keeps the lines a reader opened open while the bubble is
   * still being edited — most of a tool bubble's life. `dispatch` and `report` are drawn with a
   * mark of their own so they cannot be read as the agent's next reply; `report` also keeps the
   * folded lines of a tool bubble.
   */
  kind?: MessageKind;
  /**
   * The run of the daemon this message was said in (that run's sync `epoch`), set only on a message
   * kept on disk from an EARLIER run — a topic's transcript, restored at startup.
   *
   * The page identifies a message by `<generation>:<id>` and takes the sync's epoch as everyone's
   * generation, so without this a restored message would arrive under the new run's key: a second
   * copy beside the one its own cache kept under the old key, and drawn as live when its buttons
   * name a process that is gone. With it, it has the key the cache already has and is drawn as
   * history.
   */
  g?: number;
}
