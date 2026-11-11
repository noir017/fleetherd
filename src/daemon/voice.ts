import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { AttachmentIngestDeps } from '../core/attachment-ingest.js';
import { addressOf, type ConversationAddress } from '../core/conversation.js';
import {
  buildCleanupRequest,
  buildTranscribeRequest,
  foldVoiceLog,
  parseCleanupResponse,
  parseTranscribeResponse,
  parseVoiceButtonId,
  sniffAudio,
  VOICE_MAX_BYTES,
  VOICE_NO_SPEECH_TEXT,
  VOICE_PENDING_TTL_MS,
  VOICE_STALE_CLICK_TEXT,
  voiceAudioOf,
  voiceButtons,
  voiceCardText,
  voiceFailureText,
  type InboundAttachment,
  type CleanupParse,
  type TranscribeAudio,
  type TranscribeParse,
  type VoiceHistoryItem,
  type VoiceLogAudio,
  type VoiceLogEvent,
  type VoiceOutcome,
  type VoiceStatus,
} from '../core/voice.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ButtonInteraction, ConversationId, InboundMessage, MessageRef } from '../types.js';
import { createAttachmentIngestDeps } from './attachment-io.js';

/**
 * Voice messages, the running half: download, transcribe, show the transcript, wait for the tap,
 * hand the words on, and log every step. The decisions are core/voice.ts; read its header first.
 *
 * ── Where this sits in the inbound path ───────────────────────────────────────
 * ConversationRegistry.route() offers every message to `take()` past the access check, the gate,
 * the daemon commands and the agent binding — and before the merger. Each placement is load-bearing:
 * a message from someone not on the allowlist must not spend transcription quota; a `/stop` must
 * still be a `/stop`; and a voice note must NOT reach the merger, whose job is to interrupt the
 * running turn — a recording the user has not yet approved interrupting the agent would be exactly
 * the half-confirmed behavior the card exists to prevent. The interruption happens when the
 * transcript is sent, like any typed message.
 *
 * A confirmed transcript re-enters through `deliver` — route() again, as text — so it is answered
 * by everything a typed message is: it can answer a question the agent is waiting on, `/stop` in a
 * transcript is a `/stop`, and the 👀/✅ reactions land on the original voice note because the
 * message id is kept.
 *
 * ── Why transcriptions are serialized per conversation ────────────────────────
 * Two voice notes sent back to back are transcribed in parallel otherwise, and whichever finished
 * first would be sent first — with `confirm: false`, the agent would receive the second sentence
 * before the first. So each conversation's voice notes form one chain.
 */

/** A transcript waiting for its Send/Cancel tap. */
interface PendingVoice {
  id: string;
  conversationId: ConversationId;
  msg: InboundMessage;
  text: string;
  cleaned?: string;
  cleanupError?: string;
  model: string;
  latencyMs: number;
  adapter: PlatformAdapter;
  ref: MessageRef;
  cancelTimer: () => void;
}

/**
 * A voice note still being transcribed. What the user does meanwhile is recorded on it and applied
 * when the transcript arrives — a `/stop` or a typed correction sent while the model was still
 * listening must not be undone by a card appearing a few seconds later asking to send anyway.
 */
interface VoiceJob {
  conversationId: ConversationId;
  superseded?: boolean;
  calledOff?: string;
}

/** What `take()` and the clicks need from outside. */
export interface VoiceIntakeDeps {
  /** Adapters keyed by instance id (the daemon's paced ones, so cards share the chat's budget). */
  platforms: Map<string, PlatformAdapter>;
  /** Re-enter a confirmed transcript as a typed message (ConversationRegistry.route, marked). */
  deliver(msg: InboundMessage): void;
  clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  /** HTTP for the transcriber. Tests only; production uses the global fetch (proxy-aware). */
  fetch?: typeof fetch;
  /** Backoff between transcriber attempts. Tests only. */
  sleep?: (ms: number) => Promise<void>;
  /** Download + save. Tests only; production reuses attachment-io and its SSRF guard. */
  attachmentDeps?: (adapter: PlatformAdapter) => AttachmentIngestDeps;
  /** Where the transcript log lives. Tests only; production is `<configDir>/voice-log.jsonl`. */
  logFile?: string;
}

/** Transcriber attempts per voice note: the first, plus two retries on a transient failure. */
const MAX_ATTEMPTS = 3;
/** Backoff unit between attempts (multiplied by the attempt number). */
const RETRY_DELAY_MS = 1_500;
/**
 * Statuses worth a second attempt. The 503 is not hypothetical: "This model is currently
 * experiencing high demand" came back from gemini-3-flash on the first probe of 2026-09-25 and
 * cleared on the next call.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
/**
 * How long ONE attempt may take before it is abandoned and retried — the overall budget is the
 * configured `timeoutMs`, and this is a slice of it.
 *
 * Exists because the upstream's latency is not a distribution a single deadline suits: nine
 * transcriptions of the same six-second voice note through newapi on 2026-09-25 took 1.3, 1.5,
 * 3.9, 10.4, 12.5, 31, 34, 50 and 65 seconds. The slow ones are a stalled request, not a slow task
 * — the call made right after the 50 s one returned the same transcript in 1.3 s — so waiting out
 * a 65 s attempt makes the person holding the phone wait 65 s for what a retry likely delivers in
 * a few. Twenty seconds is past every clean answer measured for a voice note (3-15 s through the
 * real transcribe() on 2026-09-25, stalls excluded); longer recordings get more, since they
 * genuinely take longer to transcribe.
 */
const ATTEMPT_BASE_MS = 20_000;
const ATTEMPT_PER_MIB_MS = 30_000;
/** The log is rotated to `.1` past this size, so it cannot grow without bound. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Characters of a transcript quoted in daemon.log (the full text is in voice-log.jsonl). */
const LOG_PREVIEW = 60;

type TranscriberConfig = NonNullable<Config['voice']>['transcriber'];

/** A final state a card can be left in (the log also knows `failed` and `no-speech`, which have no card). */
type CardOutcome = Exclude<VoiceStatus, 'pending'>;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The readable part of an error body: new-api and Google both answer `{error:{message}}`. */
function errorDetail(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string' && message) return message.slice(0, 200);
  } catch {
    // not JSON — fall through to the raw text
  }
  return body.slice(0, 200);
}

/** A 400 refusing the thinking config — "Thinking level MINIMAL is not supported for this model". */
const refusesThinking = (status: number, detail: string): boolean => status === 400 && /thinking/i.test(detail);

/** What transcribe() takes from outside. Tests only, every one: production uses the real thing. */
interface TranscribeDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt base deadline. The real one is ATTEMPT_BASE_MS. */
  attemptBaseMs?: number;
}

/** A failed exchange; `retry` when the same request may well succeed on the next attempt. */
type Failure = { ok: false; reason: string; retry?: boolean };

/** One `generateContent` request, as generate() needs it described. */
interface Exchange<S> {
  /** Shared by every request one voice note makes: what the user waits at most. */
  overall: AbortSignal;
  /** One attempt's own deadline. */
  attemptMs: number;
  /** The body, with or without the thinking config. */
  body: (thinking: boolean) => Record<string, unknown>;
  parse: (json: unknown) => S | Failure;
}

/**
 * One `generateContent` exchange, retrying transient failures — the loop both of a voice note's
 * requests (the transcription, then the cleanup) go through.
 *
 * Two deadlines. The configured `timeoutMs` covers everything — every attempt of both requests and
 * the backoff between them — so it is what the user waits at most; each attempt also has its own,
 * shorter one (see ATTEMPT_BASE_MS), so a stuck request is retried instead of waited out.
 *
 * One 400 is retried too: a model that refuses the thinking config (the request asks for a thinking
 * level, and not every model behind an alias accepts every level) is asked again without it, rather
 * than failing a voice note over a latency optimisation. So is a 200 whose body the parser marks
 * `retry` — an empty answer, `blockReason: OTHER` — since a status code is not the only way an
 * upstream says "not this time".
 *
 * Never throws: every failure is a reason sentence, because the only caller has a user to tell.
 */
async function generate<S extends { ok: true }>(
  cfg: TranscriberConfig,
  deps: TranscribeDeps,
  call: Exchange<S>
): Promise<S | Failure> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  let thinking = true;
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.any([call.overall, AbortSignal.timeout(call.attemptMs)]);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify(call.body(thinking)),
        signal,
      });
      if (res.ok) {
        const parsed = call.parse(await res.json());
        if (parsed.ok || !parsed.retry) return parsed;
        last = parsed.reason;
      } else {
        const detail = errorDetail(await res.text().catch(() => ''));
        last = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
        if (thinking && refusesThinking(res.status, detail)) {
          thinking = false;
          continue; // the same request without the knob, at once — nothing here is transient
        }
        if (!RETRYABLE.has(res.status)) return { ok: false, reason: `the transcriber answered ${last}` };
      }
    } catch (e) {
      if (call.overall.aborted) {
        return { ok: false, reason: `the transcriber did not answer within ${Math.ceil(cfg.timeoutMs / 1000)}s` };
      }
      last = signal.aborted ? `no answer within ${Math.round(call.attemptMs / 1000)}s` : errText(e);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
  }
  return { ok: false, reason: `the transcriber failed ${MAX_ATTEMPTS} times (last: ${last})` };
}

type Heard = Extract<TranscribeParse, { ok: true }>;
type Tidied = Extract<CleanupParse, { ok: true }>;

/**
 * Transcribe a voice message's audio parts and, with `cleanup`, rewrite the transcript as the
 * message the speaker meant — two requests, one deadline (`timeoutMs`) across both.
 *
 * The cleanup is best-effort on top of a transcript that already stands: when it fails, the voice
 * note is not failed with it — the transcript comes back alone, with `cleanupError` saying why, and
 * the card shows the words as heard and that reason.
 */
export async function transcribe(
  cfg: TranscriberConfig,
  audio: TranscribeAudio[],
  deps: TranscribeDeps = {},
  opts: { cleanup?: boolean; vocabulary?: readonly string[] } = {}
): Promise<TranscribeParse> {
  const overall = AbortSignal.timeout(cfg.timeoutMs);
  const base = deps.attemptBaseMs ?? ATTEMPT_BASE_MS;
  const mib = audio.reduce((n, a) => n + (a.base64.length * 3) / 4, 0) / (1024 * 1024);
  const heard = await generate<Heard>(cfg, deps, {
    overall,
    attemptMs: Math.round(base + ATTEMPT_PER_MIB_MS * mib),
    body: (thinking) => buildTranscribeRequest(cfg.model, audio, { thinking, vocabulary: opts.vocabulary }),
    parse: parseTranscribeResponse,
  });
  if (!heard.ok || !heard.text || !opts.cleanup) return heard;
  const tidied = await generate<Tidied>(cfg, deps, {
    overall,
    attemptMs: base,
    body: (thinking) => buildCleanupRequest(cfg.model, heard.text, { thinking, vocabulary: opts.vocabulary }),
    parse: (json) => parseCleanupResponse(json, heard.text),
  });
  if (!tidied.ok) return { ...heard, cleanupError: tidied.reason };
  return tidied.cleaned === undefined ? heard : { ...heard, cleaned: tidied.cleaned };
}

/** Downloaded, identified, saved audio — or the sentence saying why not. */
type Prepared =
  | { ok: true; audio: TranscribeAudio[]; files: VoiceLogAudio[] }
  | { ok: false; reason: string; files: VoiceLogAudio[] };

/** `3.2 MB` — sizes in a sentence a user reads. */
function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const tooLarge = (bytes: number): string =>
  `the recording is too large (${megabytes(bytes)}; the limit is ${megabytes(VOICE_MAX_BYTES)})`;


/**
 * Fetch every audio part of a voice message, identify it from its bytes, and save it.
 *
 * Saved even when it then turns out untranscribable: the log points at the file, and a file the
 * agent can find is the whole of "enough to query manually" for a recording the model could not
 * read. The download goes through attachment-io, so the SSRF guard and the platform's own fetcher
 * (Feishu's authenticated resource API) apply here exactly as they do to any attachment.
 */
async function prepareAudio(atts: InboundAttachment[], io: AttachmentIngestDeps): Promise<Prepared> {
  const audio: TranscribeAudio[] = [];
  const files: VoiceLogAudio[] = [];
  let total = 0;
  for (const att of atts) {
    const one = await prepareOne(att, io, total);
    if (one.file) files.push(one.file);
    if ('reason' in one) return { ok: false, reason: one.reason, files };
    total += one.file.bytes;
    audio.push(one.audio);
  }
  return { ok: true, audio, files };
}

/** One audio part of prepareAudio. `file` is present once the bytes were saved, success or not. */
async function prepareOne(
  att: InboundAttachment,
  io: AttachmentIngestDeps,
  soFar: number
): Promise<{ file: VoiceLogAudio; audio: TranscribeAudio } | { file?: VoiceLogAudio; reason: string }> {
  if (att.size !== undefined && soFar + att.size > VOICE_MAX_BYTES) return { reason: tooLarge(soFar + att.size) };
  let got: Awaited<ReturnType<AttachmentIngestDeps['download']>>;
  try {
    got = await io.download(att.url);
  } catch (e) {
    return { reason: `it could not be downloaded (${errText(e)})` };
  }
  if (soFar + got.bytes.length > VOICE_MAX_BYTES) return { reason: tooLarge(soFar + got.bytes.length) };
  const format = sniffAudio(got.bytes);
  const declared = att.mime ?? got.contentType;
  let saved: string;
  try {
    saved = await io.save(att.name ?? got.name ?? `voice${format?.ext ?? ''}`, got.bytes);
  } catch (e) {
    return { reason: `it could not be saved (${errText(e)})` };
  }
  const file = { path: saved, mime: format?.mime ?? declared ?? 'unknown', bytes: got.bytes.length };
  if (!format) {
    return { file, reason: `its audio format is not one I recognize${declared ? ` (declared as ${declared})` : ''}` };
  }
  if (!format.supported) {
    return { file, reason: `${format.mime.slice('audio/'.length).toUpperCase()} audio cannot be transcribed here` };
  }
  return { file, audio: { mime: format.mime, base64: Buffer.from(got.bytes).toString('base64') } };
}

/** Voice messages → confirmed text. One per daemon. */
export class VoiceIntake {
  /** Cards waiting for a tap, by id (the button reqId). */
  private readonly pending = new Map<string, PendingVoice>();
  /** Voice notes still being transcribed. */
  private readonly jobs = new Set<VoiceJob>();
  /** Per-conversation tail of the transcription chain (see the file header). */
  private readonly chains = new Map<ConversationId, Promise<void>>();
  private readonly logFile: string;

  constructor(
    private readonly config: Config,
    private readonly deps: VoiceIntakeDeps
  ) {
    this.logFile = deps.logFile ?? path.join(configDir(), 'voice-log.jsonl');
  }

  /**
   * Take a voice message: true when it is one and transcription is configured, in which case the
   * caller must do nothing else with it. Everything after this returns is asynchronous.
   */
  take(conversationId: ConversationId, msg: InboundMessage): boolean {
    if (!this.config.voice) return false;
    const audio = voiceAudioOf(msg);
    if (!audio) return false;
    const adapter = this.deps.platforms.get(msg.conversation.platform);
    if (!adapter) return false;
    const job: VoiceJob = { conversationId };
    this.jobs.add(job);
    console.log(
      `[voice] ${conversationId}: voice message ${msg.messageId} from ${msg.conversation.platform}:${msg.conversation.user} (${audio.length} part(s)) — transcribing`
    );
    const run = (this.chains.get(conversationId) ?? Promise.resolve())
      .then(() => this.process(job, msg, audio, adapter))
      .catch((e) => console.error(`[voice] ${conversationId}: voice message failed:`, e instanceof Error ? e.stack : e))
      .finally(() => {
        this.jobs.delete(job);
        if (this.chains.get(conversationId) === run) this.chains.delete(conversationId);
      });
    this.chains.set(conversationId, run);
    return true;
  }

  /** One voice message, end to end. */
  private async process(
    job: VoiceJob,
    msg: InboundMessage,
    atts: InboundAttachment[],
    adapter: PlatformAdapter
  ): Promise<void> {
    const voice = this.config.voice;
    if (!voice) return;
    const id = randomUUID().slice(0, 8);
    const address = addressOf(msg.conversation);
    // A voice note can take a minute to come back (see ATTEMPT_BASE_MS), and nothing else says it
    // was received — so "typing" is kept up the whole time, on the same beat a turn uses, since a
    // single indicator expires after a few seconds on every platform that has one.
    const stopTyping = this.keepTyping(adapter, address);
    try {
      const io =
        this.deps.attachmentDeps?.(adapter) ??
        createAttachmentIngestDeps(
          this.config,
          adapter.fetchAttachment ? (url) => adapter.fetchAttachment!(url) : undefined
        );
      const prepared = await prepareAudio(atts, io);
      if (!prepared.ok) {
        this.fail(id, job, msg, adapter, address, 'failed', prepared.reason, prepared.files);
        return;
      }
      const started = this.deps.clock.now();
      // Read per voice note, like `confirm`: `/setting cleanup` is live.
      const result = await transcribe(voice.transcriber, prepared.audio, this.deps, {
        cleanup: voice.cleanup,
        vocabulary: voice.vocabulary,
      });
      const latencyMs = this.deps.clock.now() - started;
      if (!result.ok) {
        this.fail(id, job, msg, adapter, address, 'failed', result.reason, prepared.files);
        return;
      }
      if (!result.text) {
        this.fail(id, job, msg, adapter, address, 'no-speech', undefined, prepared.files);
        return;
      }
      const model = voice.transcriber.model;
      this.log({
        id,
        at: new Date(this.deps.clock.now()).toISOString(),
        event: 'transcribed',
        conversation: job.conversationId,
        platform: msg.conversation.platform,
        messageId: msg.messageId,
        user: msg.conversation.user,
        audio: prepared.files,
        model,
        latencyMs,
        usage: result.usage,
        text: result.text,
        ...(result.cleaned !== undefined ? { cleaned: result.cleaned } : {}),
        ...(result.cleanupError !== undefined ? { cleanupError: result.cleanupError } : {}),
      });
      if (result.cleanupError) console.warn(`[voice] ${job.conversationId}: ${id} not cleaned up: ${result.cleanupError}`);
      console.log(
        `[voice] ${job.conversationId}: ${id} transcribed by ${model} in ${latencyMs}ms (${result.text.length} chars` +
          `${result.cleaned !== undefined ? `, cleaned up to ${result.cleaned.length}` : ''})`
      );
      await this.present({
        id,
        job,
        msg,
        adapter,
        address,
        text: result.text,
        ...(result.cleaned !== undefined ? { cleaned: result.cleaned } : {}),
        ...(result.cleanupError !== undefined ? { cleanupError: result.cleanupError } : {}),
        model,
        latencyMs,
      });
    } catch (e) {
      // Every expected failure is a sentence above; this is the unexpected one, and it still owes
      // the user a message — a voice note that vanishes without a word is the worst outcome here.
      console.error(`[voice] ${job.conversationId}: ${id} failed unexpectedly:`, e instanceof Error ? e.stack : e);
      this.fail(id, job, msg, adapter, address, 'failed', 'an internal error (see daemon.log)', []);
    } finally {
      stopTyping();
    }
  }

  /** Fire the typing indicator now and on every beat until the returned function is called. */
  private keepTyping(adapter: PlatformAdapter, address: ConversationAddress): () => void {
    let cancel = (): void => {};
    let stopped = false;
    const beat = (): void => {
      if (stopped) return;
      void adapter.startTyping(address).catch(() => undefined);
      cancel = this.deps.clock.schedule(beat, this.config.inbound.typingIntervalMs);
    };
    beat();
    return () => {
      stopped = true;
      cancel();
      void adapter.stopTyping(address).catch(() => undefined);
    };
  }

  /**
   * Show a finished transcript, and either wait for the tap or send it on.
   *
   * `confirm` is read HERE, per voice note, rather than when the job started: `/setting voice` is
   * live, and a toggle flipped while a note was being transcribed should apply to that note.
   */
  private async present(t: {
    id: string;
    job: VoiceJob;
    msg: InboundMessage;
    adapter: PlatformAdapter;
    address: ConversationAddress;
    text: string;
    cleaned?: string;
    cleanupError?: string;
    model: string;
    latencyMs: number;
  }): Promise<void> {
    const card = (status: VoiceStatus, reason?: string): string =>
      voiceCardText({
        text: t.text,
        ...(t.cleaned !== undefined ? { cleaned: t.cleaned } : {}),
        ...(t.cleanupError !== undefined ? { cleanupError: t.cleanupError } : {}),
        model: t.model,
        latencyMs: t.latencyMs,
        status,
        ...(reason ? { reason } : {}),
      });
    // Overtaken while it was being transcribed: show it, say it was not sent, send nothing.
    const overtaken: CardOutcome | undefined = t.job.calledOff
      ? 'called-off'
      : t.job.superseded
        ? 'superseded'
        : undefined;
    if (overtaken) {
      await this.post(t.adapter, t.address, card(overtaken, t.job.calledOff));
      this.logOutcome(t.id, t.job.conversationId, overtaken, t.job.calledOff);
      return;
    }
    const confirm = this.config.voice?.confirm ?? true;
    if (confirm && t.adapter.capabilities.buttons) {
      const ref = await t.adapter
        .sendButtons(t.address, card('pending'), voiceButtons(t.id, t.cleaned !== undefined))
        .catch((e: unknown) => {
          console.warn(`[voice] ${t.job.conversationId}: could not post the card:`, e instanceof Error ? e.message : e);
          return undefined;
        });
      if (!ref) {
        // Nothing on screen to confirm, so nothing may be sent — and the user must hear about it.
        await this.post(t.adapter, t.address, voiceFailureText('the confirmation card could not be posted'));
        this.logOutcome(t.id, t.job.conversationId, 'failed', 'the confirmation card could not be posted');
        return;
      }
      const cancelTimer = this.deps.clock.schedule(() => {
        const p = this.pending.get(t.id);
        if (p) this.settle(p, 'expired');
      }, VOICE_PENDING_TTL_MS);
      this.pending.set(t.id, {
        id: t.id,
        conversationId: t.job.conversationId,
        msg: t.msg,
        text: t.text,
        ...(t.cleaned !== undefined ? { cleaned: t.cleaned } : {}),
        ...(t.cleanupError !== undefined ? { cleanupError: t.cleanupError } : {}),
        model: t.model,
        latencyMs: t.latencyMs,
        adapter: t.adapter,
        ref,
        cancelTimer,
      });
      // Overtaken while the card itself was being posted: supersede() and cancel() found nothing
      // pending then, so they only marked the job — honoured now that there is a card to retire.
      const late: CardOutcome | undefined = t.job.calledOff
        ? 'called-off'
        : t.job.superseded
          ? 'superseded'
          : undefined;
      if (late) this.settle(this.pending.get(t.id)!, late, t.job.calledOff);
      return;
    }
    // Sent on without a tap: the card still goes up FIRST, so the chat shows what the agent was
    // given before the agent's answer to it appears. What it was given is the cleaned-up version
    // when there is one — `cleanup` is the user's standing choice of which to send, as ✅ Send is.
    const status: CardOutcome = confirm ? 'auto-no-buttons' : 'auto';
    await this.post(t.adapter, t.address, card(status));
    this.logOutcome(t.id, t.job.conversationId, status);
    this.deliverTranscript(t.id, t.job.conversationId, t.msg, t.cleaned ?? t.text);
  }

  /** A failure (or silence) before any card: say so in the chat and log it. Nothing is sent on. */
  private fail(
    id: string,
    job: VoiceJob,
    msg: InboundMessage,
    adapter: PlatformAdapter,
    address: ConversationAddress,
    outcome: 'failed' | 'no-speech',
    reason: string | undefined,
    files: VoiceLogAudio[]
  ): void {
    console.warn(`[voice] ${job.conversationId}: ${id} ${outcome}${reason ? `: ${reason}` : ''}`);
    this.log({
      id,
      at: new Date(this.deps.clock.now()).toISOString(),
      event: 'outcome',
      conversation: job.conversationId,
      outcome,
      messageId: msg.messageId,
      audio: files,
      ...(reason ? { reason } : {}),
    });
    void this.post(adapter, address, outcome === 'no-speech' ? VOICE_NO_SPEECH_TEXT : voiceFailureText(reason ?? 'unknown error'));
  }

  /** Best-effort plain send: a card that could not be shown is logged, never thrown into a chain. */
  private async post(adapter: PlatformAdapter, address: ConversationAddress, text: string): Promise<void> {
    await adapter.sendMessage(address, text).then(
      () => undefined,
      (e: unknown) => console.warn('[voice] could not post to the chat:', e instanceof Error ? e.message : e)
    );
  }

  /** Hand the words on as if typed. The attachments go: the recording has been replaced by its text. */
  private deliverTranscript(id: string, conversationId: ConversationId, msg: InboundMessage, text: string): void {
    const { attachments: _audio, ...rest } = msg;
    const preview = text.length > LOG_PREVIEW ? `${text.slice(0, LOG_PREVIEW)}…` : text;
    console.log(`[voice] ${conversationId}: ${id} delivered as text: ${preview.replace(/\s+/g, ' ')}`);
    this.deps.deliver({ ...rest, content: text });
  }

  /**
   * A tap on a voice card. Returns false when the button is not one of ours, so the daemon can try
   * its other menus; every button that IS ours gets an answer, including a stale one — silence on a
   * button reads as a broken button.
   */
  onClick(ev: ButtonInteraction): boolean {
    const parsed = parseVoiceButtonId(ev.buttonId);
    if (!parsed) return false;
    const pending = this.pending.get(parsed.reqId);
    if (!pending) {
      console.log(`[voice] click on a transcript that is no longer pending (${parsed.reqId})`);
      void this.deps.platforms
        .get(ev.conversation.platform)
        ?.sendMessage(addressOf(ev.conversation), VOICE_STALE_CLICK_TEXT)
        .catch(() => undefined);
      return true;
    }
    // Re-checked for the reason every menu here re-checks: in a shared channel the person tapping
    // need not be the person who spoke, and Send puts words in front of an agent with full tool access.
    const clicker = ev.conversation;
    const allow = this.config.access.allowFrom;
    if (allow.length > 0 && !allow.includes(`${clicker.platform}:${clicker.user}`)) {
      console.log(`[access] denied voice-card click from ${clicker.platform}:${clicker.user}`);
      return true;
    }
    if (parsed.action === 'cancel') {
      this.settle(pending, 'cancelled');
      return true;
    }
    // A stale "as spoken" id on a card that never offered it cannot happen from the card itself, but
    // ids are client-supplied: with no cleaned-up version there is only one thing to send anyway.
    const asSpoken = parsed.action === 'send-as-spoken' && pending.cleaned !== undefined;
    this.settle(pending, asSpoken ? 'sent-as-spoken' : 'sent');
    const text = asSpoken ? pending.text : (pending.cleaned ?? pending.text);
    this.deliverTranscript(pending.id, pending.conversationId, pending.msg, text);
    return true;
  }

  /**
   * The user typed a message into this conversation: any transcript still waiting here, or still
   * being transcribed, is dropped in its favour. Typing is the documented way to correct a
   * transcript (the card says so), and sending both would give the agent the same thought twice.
   */
  supersede(conversationId: ConversationId): number {
    for (const job of this.jobs) if (job.conversationId === conversationId) job.superseded = true;
    return this.settleAll(conversationId, 'superseded');
  }

  /** `/stop` or `/new`: call off every transcript here, pending or in flight. Returns how many. */
  cancel(conversationId: ConversationId, reason: string): number {
    let n = 0;
    for (const job of this.jobs) {
      if (job.conversationId === conversationId && job.calledOff === undefined) {
        job.calledOff = reason;
        n++;
      }
    }
    return n + this.settleAll(conversationId, 'called-off', reason);
  }

  private settleAll(conversationId: ConversationId, status: CardOutcome, reason?: string): number {
    let n = 0;
    for (const p of [...this.pending.values()]) {
      if (p.conversationId !== conversationId) continue;
      this.settle(p, status, reason);
      n++;
    }
    return n;
  }

  /**
   * Retire a pending card: stop its timer, forget it, rewrite it with its outcome, log it.
   *
   * The rewrite strips the buttons through `editButtons(ref, text, [])` rather than a text-only
   * edit, for the reason given at daemon.ts retireAsk: only Discord and Telegram drop components on
   * a plain edit, and a live Send button under a settled transcript would answer a tap with the
   * stale-card sentence at best.
   */
  private settle(p: PendingVoice, status: CardOutcome, reason?: string): void {
    if (!this.pending.delete(p.id)) return;
    p.cancelTimer();
    const text = voiceCardText({
      text: p.text,
      ...(p.cleaned !== undefined ? { cleaned: p.cleaned } : {}),
      ...(p.cleanupError !== undefined ? { cleanupError: p.cleanupError } : {}),
      model: p.model,
      latencyMs: p.latencyMs,
      status,
      ...(reason ? { reason } : {}),
    });
    const edit = p.adapter.capabilities.editButtons
      ? p.adapter.editButtons(p.ref, text, [])
      : p.adapter.editMessage(p.ref, text);
    void edit.catch((e: unknown) =>
      console.warn(`[voice] ${p.conversationId}: could not update the card:`, e instanceof Error ? e.message : e)
    );
    console.log(`[voice] ${p.conversationId}: ${p.id} ${status}${reason ? ` (${reason})` : ''}`);
    this.logOutcome(p.id, p.conversationId, status, reason);
  }

  private logOutcome(id: string, conversation: ConversationId, outcome: VoiceOutcome, reason?: string): void {
    this.log({
      id,
      at: new Date(this.deps.clock.now()).toISOString(),
      event: 'outcome',
      conversation,
      outcome,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Append one event to the log. Synchronous so events land in the order they happened; one line
   * is a few hundred bytes. Created 0600: it holds what people said out loud. Best-effort — a log
   * that cannot be written costs the lookup, never the voice message.
   */
  private log(event: VoiceLogEvent): void {
    try {
      mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (existsSync(this.logFile) && statSync(this.logFile).size > LOG_MAX_BYTES) {
        renameSync(this.logFile, `${this.logFile}.1`);
      }
      appendFileSync(this.logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch (e) {
      console.warn('[voice] could not write the transcript log:', e instanceof Error ? e.message : e);
    }
  }

  /** This conversation's recent transcripts (`fleetherd voice-log`), newest last. */
  history(conversationId: ConversationId, limit: number): VoiceHistoryItem[] {
    const lines: string[] = [];
    for (const file of [`${this.logFile}.1`, this.logFile]) {
      try {
        lines.push(...readFileSync(file, 'utf8').split('\n'));
      } catch {
        // absent: nothing logged there yet
      }
    }
    return foldVoiceLog(lines, conversationId, limit);
  }

  /**
   * Shutdown. Pending cards stay on screen with their buttons — the adapters are going down and an
   * edit would not land — so a tap after the restart gets the stale-card sentence, and the log
   * records why nothing was sent.
   */
  dispose(): void {
    for (const p of this.pending.values()) {
      p.cancelTimer();
      this.logOutcome(p.id, p.conversationId, 'called-off', 'gateway stopped');
    }
    this.pending.clear();
  }
}
