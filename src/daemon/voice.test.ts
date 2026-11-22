import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/schema.js';
import type { AttachmentIngestDeps } from '../core/attachment-ingest.js';
import { VOICE_NO_SPEECH_TEXT, VOICE_PENDING_TTL_MS, VOICE_STALE_CLICK_TEXT } from '../core/voice.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ButtonInteraction, InboundMessage, MessageRef } from '../types.js';
import { transcribe, VoiceIntake } from './voice.js';
import { useTempDirs } from '../test-utils/temp-dir.test-helpers.js';

const makeTempDir = useTempDirs();

/**
 * The voice path end to end, minus the network: a stub adapter, a stub transcriber and a fake
 * clock. Written mostly as "what did the user SEE, and what did the agent GET" — the two
 * questions every branch here has to answer, and the two a silent failure gets wrong.
 */

const CONV = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
const KEY = 'tg#c1#';

/** Ogg-framed bytes: what a Telegram voice note really is, whatever its mime says. */
const OGG = Buffer.from('OggS\x00\x02 pretend opus', 'binary');
const AMR = Buffer.from('#!AMR\n pretend amr', 'binary');

const geminiOk = (text: string): Response =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 25 }] },
    }),
    { status: 200 }
  );
const geminiErr = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message, type: 'upstream_error' } }), { status });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

interface RigOpts {
  confirm?: boolean;
  /**
   * `voice.cleanup`. Off unless a test asks: most of this file is about the card's lifecycle, which
   * is the same either way, and reads most plainly against the one-text card. The default being ON
   * is asserted on its own below.
   */
  cleanup?: boolean;
  vocabulary?: string[];
  buttons?: boolean;
  responses?: Array<Response | Error | Promise<Response>>;
  timeoutMs?: number;
  download?: (url: string) => Promise<{ bytes: Uint8Array }>;
  /** Hold the card's own send open until this settles — the window a race lives in. */
  holdCard?: Promise<void>;
}

function rig(opts: RigOpts = {}) {
  const dir = makeTempDir('aa-voice-');
  const logFile = path.join(dir, 'voice-log.jsonl');
  const config = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    access: { allowFrom: ['tg:u1'] },
    voice: {
      confirm: opts.confirm ?? true,
      cleanup: opts.cleanup ?? false,
      ...(opts.vocabulary ? { vocabulary: opts.vocabulary } : {}),
      transcriber: {
        baseUrl: 'http://gw:3000/v1beta/',
        apiKey: 'sk-test',
        model: 'gemini-3-flash',
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      },
    },
  });

  const sent: string[] = [];
  const cards: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const edits: Array<{ messageId: string; text: string; buttons?: unknown[] }> = [];
  const adapter = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: { buttons: opts.buttons ?? true, editButtons: true, editMessage: true },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `s${sent.length}` };
    },
    sendButtons: async (address: { channel: string }, text: string, buttons: Array<{ id: string; label: string }>) => {
      if (opts.holdCard) await opts.holdCard;
      cards.push({ text, buttons });
      return { address, messageId: `card${cards.length}` };
    },
    editButtons: async (ref: MessageRef, text: string, buttons: unknown[]) => {
      edits.push({ messageId: ref.messageId, text, buttons });
    },
    editMessage: async (ref: MessageRef, text: string) => {
      edits.push({ messageId: ref.messageId, text });
    },
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const clock = {
    now: () => 1_790_000_000_000,
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
  };

  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const queue = [...(opts.responses ?? [])];
  const fetchImpl = (async (url: string, init: RequestInit & { signal?: AbortSignal }) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = queue.shift() ?? geminiOk('你好');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;

  const saved: string[] = [];
  const io: AttachmentIngestDeps = {
    download:
      opts.download ??
      (async (url) => ({ bytes: new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')) })),
    save: async (name) => {
      saved.push(name);
      return `/cache/${name}`;
    },
  };

  const delivered: InboundMessage[] = [];
  const intake = new VoiceIntake(config, {
    platforms: new Map([['tg', adapter]]),
    deliver: (m) => void delivered.push(m),
    clock,
    fetch: fetchImpl,
    sleep: async () => {},
    attachmentDeps: () => io,
    logFile,
  });

  let n = 0;
  const voice = (data: Buffer = OGG, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    conversation: CONV,
    messageId: `v${++n}`,
    content: '',
    timestamp: 1,
    attachments: [{ type: 'audio', url: `data:audio/opus;base64,${data.toString('base64')}` }],
    ...extra,
  });
  const click = (buttonId: string, user = 'u1'): boolean =>
    intake.onClick({ conversation: { ...CONV, user }, messageId: 'cb', buttonId } satisfies ButtonInteraction);
  const logLines = (): Array<Record<string, unknown>> =>
    readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  return { config, intake, voice, click, sent, cards, edits, delivered, requests, timers, saved, logFile, logLines };
}

describe('confirm mode (the default)', () => {
  it('shows the transcript with Send/Cancel and sends nothing until tapped', async () => {
    const r = rig();
    expect(r.intake.take(KEY, r.voice())).toBe(true);
    await flush();
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]!.text).toMatch(/^🎙️ Voice transcript · gemini-3-flash · /);
    expect(r.cards[0]!.text).toContain('你好');
    expect(r.cards[0]!.buttons.map((b) => b.label)).toEqual(['✅ Send', '✖ Cancel']);
    expect(r.delivered).toEqual([]);
  });

  it('asks the configured Gemini endpoint, with the SNIFFED container rather than the declared label', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.url).toBe('http://gw:3000/v1beta/models/gemini-3-flash:generateContent');
    expect(r.requests[0]!.headers['x-goog-api-key']).toBe('sk-test');
    const parts = (r.requests[0]!.body['contents'] as Array<{ parts: Array<{ inline_data: { mime_type: string } }> }>)[0]!.parts;
    expect(parts[0]!.inline_data.mime_type).toBe('audio/ogg'); // declared audio/opus (the codec); the bytes are Ogg
  });

  it('Send hands the words on as the same message, typed: no attachments, same id', async () => {
    const r = rig();
    const msg = r.voice();
    r.intake.take(KEY, msg);
    await flush();
    expect(r.click(r.cards[0]!.buttons[0]!.id)).toBe(true);
    expect(r.delivered).toHaveLength(1);
    expect(r.delivered[0]!.content).toBe('你好');
    expect(r.delivered[0]!.attachments).toBeUndefined();
    expect(r.delivered[0]!.messageId).toBe(msg.messageId); // so 👀/✅ land on the voice note
    expect(r.edits.at(-1)).toMatchObject({ messageId: 'card1', buttons: [] });
    expect(r.edits.at(-1)!.text).toMatch(/Sent to the agent\.$/);
  });

  it('Cancel sends nothing and says so', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    r.click(r.cards[0]!.buttons[1]!.id);
    expect(r.delivered).toEqual([]);
    expect(r.edits.at(-1)!.text).toMatch(/Cancelled — nothing was sent/);
  });

  it('a second tap on a settled card, or one after a restart, is answered — never silent', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    const send = r.cards[0]!.buttons[0]!.id;
    r.click(send);
    expect(r.click(send)).toBe(true);
    expect(r.sent.at(-1)).toBe(VOICE_STALE_CLICK_TEXT);
    expect(r.delivered).toHaveLength(1);
  });

  it('a tap from someone off the allowlist sends nothing and leaves the card up', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    r.click(r.cards[0]!.buttons[0]!.id, 'stranger');
    expect(r.delivered).toEqual([]);
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered).toHaveLength(1);
  });

  it('expires after its TTL, sending nothing', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    const timer = r.timers.find((t) => t.ms === VOICE_PENDING_TTL_MS)!;
    timer.fn();
    expect(r.edits.at(-1)!.text).toMatch(/Expired after 30 min — nothing was sent/);
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered).toEqual([]);
  });

  it('is not our button → false, so the daemon tries its other menus', () => {
    expect(rig().click('ask:ab12:0')).toBe(false);
  });
});

describe('sending on without a tap', () => {
  it('confirm: false posts the card FIRST, marked automatic, then delivers', async () => {
    const r = rig({ confirm: false });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.cards).toEqual([]);
    expect(r.sent[0]).toMatch(/Voice transcript[\s\S]*你好[\s\S]*Sent to the agent automatically\.$/);
    expect(r.delivered.map((m) => m.content)).toEqual(['你好']);
  });

  it('a platform without buttons degrades to sending on, and the card says why', async () => {
    const r = rig({ buttons: false });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.sent[0]).toMatch(/this platform cannot show confirm buttons/);
    expect(r.delivered).toHaveLength(1);
  });

  it('reads `confirm` when the transcript is ready, so a live /setting applies to a note in flight', async () => {
    const r = rig({ confirm: true });
    r.intake.take(KEY, r.voice());
    r.config.voice!.confirm = false;
    await flush();
    expect(r.cards).toEqual([]);
    expect(r.delivered).toHaveLength(1);
  });

  it('keeps two voice notes in the order they were sent, however long each takes', async () => {
    let releaseFirst = (): void => {};
    const slow = new Promise<Response>((res) => void (releaseFirst = () => res(geminiOk('first'))));
    const r = rig({ confirm: false, responses: [slow, geminiOk('second')] });
    r.intake.take(KEY, r.voice());
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.delivered).toEqual([]); // the second waits behind the first
    releaseFirst();
    await flush();
    expect(r.delivered.map((m) => m.content)).toEqual(['first', 'second']);
  });
});

describe('overtaken by the user', () => {
  it('typing drops a waiting card (typing is how a transcript is corrected)', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.intake.supersede(KEY)).toBe(1);
    expect(r.edits.at(-1)!.text).toMatch(/Replaced by the message you typed/);
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered).toEqual([]);
  });

  it('typing while it is still being transcribed: the card arrives already marked, never pending', async () => {
    let release = (): void => {};
    const held = new Promise<Response>((res) => void (release = () => res(geminiOk('late'))));
    const r = rig({ responses: [held] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.intake.supersede(KEY)).toBe(0);
    release();
    await flush();
    expect(r.cards).toEqual([]);
    expect(r.sent[0]).toMatch(/late[\s\S]*Replaced by the message you typed/);
    expect(r.delivered).toEqual([]);
  });

  it('typing while the card itself is being posted still drops it — never left pending', async () => {
    let release = (): void => {};
    const r = rig({ holdCard: new Promise<void>((res) => void (release = res)) });
    r.intake.take(KEY, r.voice());
    await flush(); // transcribed; the card's send is in flight
    r.intake.supersede(KEY);
    release();
    await flush();
    expect(r.edits.at(-1)!.text).toMatch(/Replaced by the message you typed/);
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered).toEqual([]);
  });

  it('/stop calls off a waiting card and one in flight, and counts both', async () => {
    let release = (): void => {};
    const held = new Promise<Response>((res) => void (release = () => res(geminiOk('two'))));
    const r = rig({ responses: [geminiOk('one'), held] });
    r.intake.take(KEY, r.voice());
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.cards).toHaveLength(1);
    expect(r.intake.cancel(KEY, 'stopped')).toBe(2);
    expect(r.edits.at(-1)!.text).toMatch(/Called off \(stopped\) — nothing was sent/);
    release();
    await flush();
    expect(r.sent.at(-1)).toMatch(/two[\s\S]*Called off \(stopped\)/);
    expect(r.delivered).toEqual([]);
  });

  it('only touches its own conversation', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.intake.supersede('tg#other#')).toBe(0);
    expect(r.intake.cancel('tg#other#', 'stopped')).toBe(0);
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered).toHaveLength(1);
  });
});

describe('cleanup (voice.cleanup)', () => {
  const spoken = '然后 把那个 把把它部署到 Unraid 上';
  const cleaned = '把它部署到 Unraid 上。';

  it('is on by default', () => {
    const config = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
      voice: { transcriber: { baseUrl: 'http://gw/v1beta', apiKey: 'k', model: 'gemini-3-flash' } },
    });
    expect(config.voice).toMatchObject({ cleanup: true, vocabulary: [] });
  });

  it('transcribes first, then rewrites the TRANSCRIPT in a text-only request, both with the vocabulary', async () => {
    const r = rig({ cleanup: true, vocabulary: ['Unraid'], responses: [geminiOk(spoken), geminiOk(cleaned)] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(2);
    const system = (i: number) => (r.requests[i]!.body['systemInstruction'] as { parts: Array<{ text: string }> }).parts[0]!.text;
    expect(system(0)).toMatch(/^You are a speech-to-text engine/);
    expect(system(1)).toMatch(/^You turn a speech-to-text transcript into the message/);
    for (const i of [0, 1]) expect(system(i)).toMatch(/Names that often come up: .*, CI, Unraid\./);
    expect(r.requests[1]!.body['contents']).toEqual([{ role: 'user', parts: [{ text: `<transcript>\n${spoken}\n</transcript>` }] }]);
  });

  it('a cleanup that fails leaves the transcript standing, and the card says why', async () => {
    const busy = (): Response => geminiErr(503, 'high demand');
    const r = rig({ cleanup: true, responses: [geminiOk(spoken), busy(), busy(), busy()] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.cards[0]!.text).toContain(`${spoken}\n\n✍️ Not cleaned up: the transcriber failed 3 times (last: HTTP 503: high demand).`);
    expect(r.cards[0]!.buttons.map((b) => b.label)).toEqual(['✅ Send', '✖ Cancel']);
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered.map((m) => m.content)).toEqual([spoken]);
    expect(r.logLines()[0]).toMatchObject({ event: 'transcribed', text: spoken, cleanupError: expect.stringContaining('HTTP 503') });
  });

  it('heard no speech: nothing to clean up, and no second request', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk('[no speech]')] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(1);
    expect(r.sent).toEqual([VOICE_NO_SPEECH_TEXT]);
  });

  it('shows both, cleaned-up first, with a third button for the words as heard', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk(spoken), geminiOk(cleaned)] });
    r.intake.take(KEY, r.voice());
    await flush();
    const card = r.cards[0]!;
    expect(card.text).toMatch(/✍️ Cleaned up:\n把它部署到 Unraid 上。\n\n🗣️ As spoken:\n然后 把那个/);
    expect(card.buttons.map((b) => b.label)).toEqual(['✅ Send', '🗣️ Send as spoken', '✖ Cancel']);
  });

  it('✅ Send sends the cleaned-up version, and the card says so', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk(spoken), geminiOk(cleaned)] });
    r.intake.take(KEY, r.voice());
    await flush();
    r.click(r.cards[0]!.buttons[0]!.id);
    expect(r.delivered.map((m) => m.content)).toEqual([cleaned]);
    expect(r.edits.at(-1)!.text).toMatch(/Sent the cleaned-up version to the agent\.$/);
    expect(r.logLines().at(-1)).toMatchObject({ event: 'outcome', outcome: 'sent' });
  });

  it('🗣️ Send as spoken sends the words as heard instead', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk(spoken), geminiOk(cleaned)] });
    r.intake.take(KEY, r.voice());
    await flush();
    r.click(r.cards[0]!.buttons[1]!.id);
    expect(r.delivered.map((m) => m.content)).toEqual([spoken]);
    expect(r.edits.at(-1)!.text).toMatch(/Sent to the agent as spoken\.$/);
    expect(r.intake.history(KEY, 10)).toMatchObject([{ status: 'sent-as-spoken', text: spoken, cleaned }]);
  });

  it('confirm: false sends the cleaned-up version, and the card shows both', async () => {
    const r = rig({ cleanup: true, confirm: false, responses: [geminiOk(spoken), geminiOk(cleaned)] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.sent[0]).toMatch(/Cleaned up:[\s\S]*As spoken:[\s\S]*Sent the cleaned-up version to the agent automatically\.$/);
    expect(r.delivered.map((m) => m.content)).toEqual([cleaned]);
  });

  it('logs both versions', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk(spoken), geminiOk(cleaned)] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.logLines()[0]).toMatchObject({ event: 'transcribed', text: spoken, cleaned });
  });

  it('with nothing to clean up, the card is the one-text card it always was', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk('看一下。'), geminiOk('看一下。')] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.cards[0]!.text).not.toMatch(/Cleaned up|As spoken/);
    expect(r.cards[0]!.buttons.map((b) => b.label)).toEqual(['✅ Send', '✖ Cancel']);
  });

  it('reads the switch per voice note, so /setting cleanup applies to the next one', async () => {
    const r = rig({ cleanup: true, responses: [geminiOk('你好')] });
    r.config.voice!.cleanup = false;
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(1);
  });
});

describe('what is not taken', () => {
  it('a caption makes the audio material, not speech', () => {
    const r = rig();
    expect(r.intake.take(KEY, r.voice(OGG, { content: 'trim this recording' }))).toBe(false);
  });

  it('nothing is taken when voice: is not configured', () => {
    const config = parseConfig({
      platforms: { tg: { type: 'telegram', token: 't' } },
      agents: [{ id: 'cc', harness: 'claude' }],
      routing: { default: 'cc' },
    });
    const intake = new VoiceIntake(config, {
      platforms: new Map(),
      deliver: () => {},
      clock: { now: () => 0, schedule: () => () => {} },
      logFile: path.join(makeTempDir('aa-voice-'), 'x.jsonl'),
    });
    expect(
      intake.take(KEY, { conversation: CONV, messageId: 'v', content: '', timestamp: 1, attachments: [{ type: 'audio', url: 'data:audio/ogg;base64,AA==' }] })
    ).toBe(false);
  });
});

describe('failures are said out loud, and nothing is sent', () => {
  it('retries a transient 503 and succeeds', async () => {
    const r = rig({ responses: [geminiErr(503, 'This model is currently experiencing high demand.'), geminiOk('ok now')] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(2);
    expect(r.cards[0]!.text).toContain('ok now');
  });

  it('gives up after three transient failures, quoting the upstream reason', async () => {
    const busy = (): Response => geminiErr(503, 'high demand');
    const r = rig({ responses: [busy(), busy(), busy()] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(3);
    expect(r.sent[0]).toMatch(/^🎙️ Couldn't transcribe that voice message: the transcriber failed 3 times \(last: HTTP 503: high demand\)/);
    expect(r.cards).toEqual([]);
    expect(r.delivered).toEqual([]);
  });

  it('retries an answer that came back empty, or blocked for no stated reason, and succeeds', async () => {
    const empty = new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }), { status: 200 });
    const other = new Response(JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } }), { status: 200 });
    const r = rig({ responses: [empty, other, geminiOk('third time')] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(3);
    expect(r.cards[0]!.text).toContain('third time');
  });

  it('says an empty answer failed rather than that the recording was silent', async () => {
    const empty = (): Response =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }), { status: 200 });
    const r = rig({ responses: [empty(), empty(), empty()] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.sent[0]).toMatch(/failed 3 times \(last: the transcriber returned an empty answer\)/);
    expect(r.sent).not.toContain(VOICE_NO_SPEECH_TEXT);
  });

  it('does not retry a request the upstream rejected', async () => {
    const r = rig({ responses: [geminiErr(400, 'Invalid audio')] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(1);
    expect(r.sent[0]).toMatch(/HTTP 400: Invalid audio/);
  });

  it('names an unsupported codec, keeps the file, and never calls the transcriber', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice(AMR));
    await flush();
    expect(r.requests).toEqual([]);
    expect(r.sent[0]).toMatch(/AMR audio cannot be transcribed here/);
    expect(r.intake.history(KEY, 10)).toMatchObject([{ status: 'failed', audio: '/cache/voice.amr' }]);
  });

  it('says a failed download failed', async () => {
    const r = rig({
      download: async () => {
        throw new Error('HTTP 404');
      },
    });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.sent[0]).toMatch(/could not be downloaded \(HTTP 404\)/);
  });

  it('says so when it heard no speech', async () => {
    const r = rig({ responses: [geminiOk('[no speech]')] });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.sent).toEqual([VOICE_NO_SPEECH_TEXT]);
    expect(r.delivered).toEqual([]);
  });

  it('asks again WITHOUT the thinking config when a model refuses it, instead of failing the note', async () => {
    const r = rig({
      responses: [geminiErr(400, 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.'), geminiOk('ok')],
    });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.requests).toHaveLength(2);
    const config = (i: number) => (r.requests[i]!.body['generationConfig'] as Record<string, unknown>)['thinkingConfig'];
    expect(config(0)).toEqual({ thinkingLevel: 'low' });
    expect(config(1)).toBeUndefined();
    expect(r.cards[0]!.text).toContain('ok');
  });

  it('abandons a stalled attempt and retries it, rather than waiting it out', async () => {
    let calls = 0;
    const stallThenAnswer = (_url: string, init: { signal: AbortSignal }): Promise<Response> => {
      calls++;
      if (calls === 1) {
        return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
      }
      return Promise.resolve(geminiOk('second try'));
    };
    const result = await transcribe(
      { baseUrl: 'http://gw/v1beta', apiKey: 'k', model: 'gemini-3-flash', timeoutMs: 5_000 },
      [{ mime: 'audio/ogg', base64: 'AA==' }],
      { fetch: stallThenAnswer as unknown as typeof fetch, sleep: async () => {}, attemptBaseMs: 20 }
    );
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, text: 'second try' });
  });

  it('bounds the whole attempt with one deadline', async () => {
    const hang = (_url: string, init: { signal: AbortSignal }): Promise<Response> =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    const result = await transcribe(
      { baseUrl: 'http://gw/v1beta', apiKey: 'k', model: 'gemini-3-flash', timeoutMs: 20 },
      [{ mime: 'audio/ogg', base64: 'AA==' }],
      { fetch: hang as unknown as typeof fetch, sleep: async () => {} }
    );
    expect(result).toEqual({ ok: false, reason: 'the transcriber did not answer within 1s' });
  });
});

describe('the log', () => {
  it('records the transcript and its outcome, with the audio, in a 0600 file', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    r.click(r.cards[0]!.buttons[0]!.id);
    const [transcribed, outcome] = r.logLines();
    expect(transcribed).toMatchObject({
      event: 'transcribed',
      conversation: KEY,
      platform: 'tg',
      user: 'u1',
      model: 'gemini-3-flash',
      text: '你好',
      audio: [{ path: '/cache/voice.ogg', mime: 'audio/ogg' }],
      usage: { audioTokens: 25 },
    });
    expect(outcome).toMatchObject({ event: 'outcome', id: transcribed!['id'], outcome: 'sent' });
    expect(statSync(r.logFile).mode & 0o777).toBe(0o600);
  });

  it('history() folds it for voice-log', async () => {
    const r = rig({ confirm: false });
    r.intake.take(KEY, r.voice());
    await flush();
    expect(r.intake.history(KEY, 10)).toMatchObject([{ status: 'auto', text: '你好', model: 'gemini-3-flash' }]);
    expect(r.intake.history('tg#other#', 10)).toEqual([]);
  });

  it('records pending cards as called off on shutdown', async () => {
    const r = rig();
    r.intake.take(KEY, r.voice());
    await flush();
    r.intake.dispose();
    expect(r.intake.history(KEY, 10)).toMatchObject([{ status: 'called-off', reason: 'gateway stopped' }]);
  });
});

describe('OpenAI audio transcriber, dedicated cleaner, and web dictation buffer', () => {
  it('transcribes via multipart /audio/transcriptions and cleans up via dedicated OpenAI cleaner', async () => {
    const calls: Array<{ url: string; auth: string | null; isForm: boolean; bodyText?: string }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const isForm = init?.body instanceof FormData;
      calls.push({
        url,
        auth: headers.get('authorization'),
        isForm,
        ...(typeof init?.body === 'string' ? { bodyText: init.body } : {}),
      });
      if (isForm) {
        const form = init.body as FormData;
        expect(form.get('model')).toBe('groq-whisper-large-v3-turbo');
        expect(form.get('language')).toBe('zh');
        expect(String(form.get('prompt'))).toContain('Unraid');
        return new Response(JSON.stringify({ text: '那个把 fleetherd 部署到 A 不对 Unraid 上' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '把 fleetherd 部署到 Unraid 上。' } }] }),
        { status: 200 }
      );
    };

    const res = await transcribe(
      {
        format: 'openai-audio',
        baseUrl: 'http://newapi:3000/v1',
        apiKey: 'sk-voice',
        model: 'groq-whisper-large-v3-turbo',
        language: 'zh',
        timeoutMs: 30_000,
      },
      [{ mime: 'audio/ogg', base64: OGG.toString('base64') }],
      { fetch: fakeFetch, sleep: async () => {} },
      {
        cleanup: true,
        vocabulary: ['Unraid'],
        cleaner: {
          format: 'openai',
          baseUrl: 'http://newapi:3000/v1',
          apiKey: 'sk-voice',
          model: 'groq-qwen3.8-27b',
          timeoutMs: 15_000,
        },
      }
    );

    expect(res).toMatchObject({
      ok: true,
      text: '那个把 fleetherd 部署到 A 不对 Unraid 上',
      cleaned: '把 fleetherd 部署到 Unraid 上。',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: 'http://newapi:3000/v1/audio/transcriptions', auth: 'Bearer sk-voice', isForm: true });
    expect(calls[1]).toMatchObject({ url: 'http://newapi:3000/v1/chat/completions', auth: 'Bearer sk-voice', isForm: false });
  });

  it('skips cleanup when openai-audio has no dedicated cleaner', async () => {
    let count = 0;
    const fakeFetch: typeof fetch = async () => {
      count++;
      return new Response(JSON.stringify({ text: '你好世界' }), { status: 200 });
    };
    const res = await transcribe(
      { format: 'openai-audio', baseUrl: 'http://newapi:3000/v1', apiKey: 'sk', model: 'whisper', timeoutMs: 10_000 },
      [{ mime: 'audio/ogg', base64: OGG.toString('base64') }],
      { fetch: fakeFetch, sleep: async () => {} },
      { cleanup: true }
    );
    expect(count).toBe(1);
    expect(res).toEqual({ ok: true, text: '你好世界', usage: {} });
  });

  it('VoiceIntake.transcribeBuffer returns cleaned dictation directly and handles silence/unsupported audio', async () => {
    const r = rig({
      cleanup: true,
      responses: [geminiOk('然后 部署到 oracle'), geminiOk('部署到 oracle。'), geminiOk('[no speech]')],
    });
    expect(r.intake.isConfigured()).toBe(true);
    const ok = await r.intake.transcribeBuffer(OGG, 'audio/ogg');
    expect(ok).toMatchObject({ ok: true, text: '然后 部署到 oracle', cleaned: '部署到 oracle。', model: 'gemini-3-flash' });

    const silent = await r.intake.transcribeBuffer(OGG, 'audio/ogg');
    expect(silent).toMatchObject({ ok: false, noSpeech: true });

    const bad = await r.intake.transcribeBuffer(AMR, 'audio/amr');
    expect(bad).toMatchObject({ ok: false, reason: 'AMR audio cannot be transcribed here' });
  });
});
