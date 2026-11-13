import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAgentError, type BackendEvent, type TurnRequest } from './backend.js';
import { ATTACHMENTS_MARKER, createMailboxBackend, formatDuration, joinText, splitAttachments, type MailboxBackendOptions } from './mailbox.js';

/**
 * The mailbox backend against an in-memory relay with the agent-mailbox client protocol, and a
 * clock the test moves. `agent` is the other side: what it does is scripted per test, run each
 * time the backend sleeps (the backend sleeps between every poll, so the script sees every step).
 */

interface Msg { seq: number; session: string; turn: string; type: 'message' | 'cancel'; text: string }
interface Rep { seq: number; session: string; turn: string | null; type: 'progress' | 'final' | 'message'; text: string }

class FakeRelay {
  inbox: Msg[] = [];
  replies: Rep[] = [];
  sent: Msg[] = [];
  cancels: { session: string; turn: string; withdraw_only: boolean }[] = [];
  lastPollAt: number | null = null;
  fetchedUpto = 0;
  private inboxSeq = 0;
  private replySeq = 0;
  failNext: number[] = [];
  requests: { method: string; path: string; auth: string | null }[] = [];

  constructor(private readonly clock: { now: number }) {}

  status() {
    return { last_poll_at: this.lastPollAt, fetched_upto: this.fetchedUpto, acked_upto: 0 };
  }

  // ── the agent's side, for the scripts ──
  agentPoll(): Msg[] {
    this.lastPollAt = this.clock.now;
    const fresh = this.inbox.filter((m) => m.seq > this.fetchedUpto);
    if (fresh.length) this.fetchedUpto = fresh.at(-1)!.seq;
    return fresh;
  }
  agentReply(session: string, turn: string | null, type: Rep['type'], text: string): void {
    this.replies.push({ seq: ++this.replySeq, session, turn, type, text });
  }

  // ── the client side, over fetch ──
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    this.requests.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, auth });
    const fail = this.failNext.shift();
    if (fail) return json(fail, { ok: false, error: `status ${fail}` });
    if (auth !== 'Bearer mbc_test') return json(401, { ok: false, error: 'unauthorized' });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.pathname === '/client/send') return this.send(body);
    if (url.pathname === '/client/replies') return this.page(url);
    if (url.pathname === '/client/cancel') return this.cancel(body);
    return json(404, { ok: false, error: 'not found' });
  };

  private send(body: Record<string, unknown>): Response {
    const session = String(body.session);
    const turn = String(body.turn);
    const dup = this.inbox.find((m) => m.session === session && m.turn === turn && m.type === 'message');
    if (dup && body.type === 'message') return json(200, { ok: true, seq: dup.seq, turn, agent: this.status() });
    const msg: Msg = { seq: ++this.inboxSeq, session, turn, type: body.type as Msg['type'], text: String(body.text) };
    this.inbox.push(msg);
    this.sent.push(msg);
    return json(200, { ok: true, seq: msg.seq, turn, agent: this.status() });
  }

  private page(url: URL): Response {
    const session = url.searchParams.get('session');
    const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
    if (after !== undefined) this.replies = this.replies.filter((r) => !(r.session === session && r.seq <= after));
    const page = this.replies.filter((r) => r.session === session && r.seq > (after ?? 0));
    return json(200, { ok: true, replies: page, cursor: page.at(-1)?.seq ?? after ?? 0, agent: this.status() });
  }

  private cancel(body: Record<string, unknown>): Response {
    const c = { session: String(body.session), turn: String(body.turn), withdraw_only: body.withdraw_only === true };
    this.cancels.push(c);
    const unfetched = this.inbox.filter((m) => m.session === c.session && m.turn === c.turn && m.seq > this.fetchedUpto);
    if (unfetched.length) {
      this.inbox = this.inbox.filter((m) => !unfetched.includes(m));
      return json(200, { ok: true, withdrawn: unfetched.length, agent: this.status() });
    }
    if (c.withdraw_only) return json(200, { ok: true, withdrawn: 0, agent: this.status() });
    const msg: Msg = { seq: ++this.inboxSeq, session: c.session, turn: c.turn, type: 'cancel', text: '' };
    this.inbox.push(msg);
    return json(200, { ok: true, withdrawn: 0, seq: msg.seq, agent: this.status() });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const START = Date.UTC(2026, 10, 13, 12, 0, 0);

function rig(script: (now: number, relay: FakeRelay) => void = () => {}, extra: Partial<MailboxBackendOptions> = {}) {
  const clock = { now: START };
  const relay = new FakeRelay(clock);
  const logs: string[] = [];
  let turns = 0;
  const backend = createMailboxBackend({
    url: 'https://relay.example.com',
    token: 'mbc_test',
    fetch: relay.fetch as typeof fetch,
    now: () => clock.now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      clock.now += ms;
      script(clock.now - START, relay);
      await Promise.resolve();
    },
    newTurnId: () => `t${++turns}`,
    log: (line) => logs.push(line),
    ...extra,
  });
  return { backend, relay, clock, logs };
}

function request(text: string, signal = new AbortController().signal, sessionId = 'sess-1'): TurnRequest {
  return { sessionId, text, images: [], model: '', signal };
}

async function collect(gen: AsyncGenerator<BackendEvent>): Promise<BackendEvent[]> {
  const out: BackendEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const textOf = (events: BackendEvent[]) =>
  events.filter((e): e is Extract<BackendEvent, { type: 'text' }> => e.type === 'text').map((e) => e.text).join('');

afterEach(() => {
  vi.useRealTimers();
});

describe('a turn', () => {
  it('delivers the message, draws progress as a tool row and ends at the final', async () => {
    const { backend, relay } = rig((t, r) => {
      if (t === 4_000) r.agentPoll();
      if (t === 6_000) r.agentReply('sess-1', 't1', 'progress', 'reading the question');
      if (t === 10_000) r.agentReply('sess-1', 't1', 'final', 'the answer');
    });
    const events = await collect(backend.turn(request('what is it?')));
    expect(relay.sent).toEqual([{ seq: 1, session: 'sess-1', turn: 't1', type: 'message', text: 'what is it?' }]);
    expect(events).toEqual([
      { type: 'state', lastInteractionId: 't1' },
      { type: 'tool_start', id: 'progress-t1-1', title: 'progress', kind: 'other', rawInput: { prompt: 'reading the question' } },
      { type: 'tool_end', id: 'progress-t1-1', status: 'completed' },
      { type: 'text', text: 'the answer' },
      { type: 'done' },
    ]);
    // The final was confirmed before the turn ended, so a restart will not show it again.
    expect(relay.replies).toEqual([]);
    expect(relay.requests.every((r) => r.auth === 'Bearer mbc_test' && !r.path.includes('mbc_test'))).toBe(true);
  });

  it('joins several messages and the final into one body', async () => {
    const { backend } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'message', 'part one');
        r.agentReply('sess-1', 't1', 'message', 'part two\n\n');
        r.agentReply('sess-1', 't1', 'final', 'last');
      }
    });
    expect(textOf(await collect(backend.turn(request('q'))))).toBe('part one\n\npart two\n\nlast');
  });

  it('fails after the pickup timeout, withdraws the message and says when the agent last polled', async () => {
    const { backend, relay } = rig();
    relay.lastPollAt = START - 14 * 60_000;
    const err = await collect(backend.turn(request('anyone there?'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiAgentError);
    expect((err as Error).message).toBe(
      'nobody picked the message up from the mailbox in 2 min; the agent last polled 16 min ago (2026-11-13 11:46 UTC) — it was withdrawn; send it again once the agent is polling',
    );
    expect(relay.cancels).toEqual([{ session: 'sess-1', turn: 't1', withdraw_only: true }]);
    expect(relay.inbox).toEqual([]);
  });

  it('says so when the agent never polled at all', async () => {
    const { backend } = rig();
    const err = await collect(backend.turn(request('hello'))).catch((e: unknown) => e);
    expect((err as Error).message).toContain('the agent has never polled this mailbox');
  });

  it('ends a picked-up turn after the silence limit, with what arrived and a note', async () => {
    const { backend } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'progress', 'working');
        r.agentReply('sess-1', 't1', 'message', 'half an answer');
      }
    });
    const events = await collect(backend.turn(request('q')));
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([{ type: 'tool_end', id: 'progress-t1-1', status: 'completed' }]);
    expect(textOf(events)).toBe(
      'half an answer\n\n(No completion mark: no reply from the agent for 5 min, so this turn ends here. Anything the agent sends later arrives as a separate message.)',
    );
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('marks an open progress row failed when the silence limit hits', async () => {
    const { backend, clock } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'progress', 'stuck');
      }
    }, { silenceTimeoutMs: 30_000 });
    const events = await collect(backend.turn(request('q')));
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([{ type: 'tool_end', id: 'progress-t1-1', status: 'failed' }]);
    expect(clock.now - START).toBeLessThan(40_000);
  });

  it('a pickup that lands at the deadline continues the turn', async () => {
    const { backend } = rig((t, r) => {
      if (t === 120_000) r.agentPoll();
      if (t === 124_000) r.agentReply('sess-1', 't1', 'final', 'made it');
    });
    expect(textOf(await collect(backend.turn(request('q'))))).toBe('made it');
  });

  it('retries a failed delivery with the same turn id', async () => {
    const { backend, relay } = rig((t, r) => {
      if (t >= 2_000 && t <= 4_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'final', 'ok');
      }
    });
    relay.failNext = [0, 502]; // the first request reads earlier replies; the second is the send
    expect(textOf(await collect(backend.turn(request('q'))))).toBe('ok');
    expect(relay.requests.filter((r) => r.path === '/client/send')).toHaveLength(2);
    expect(relay.sent).toHaveLength(1);
  });

  it('turns a rejected token into a sentence about MAILBOX_TOKEN', async () => {
    const { backend, relay } = rig();
    relay.failNext = [401];
    const err = await collect(backend.turn(request('q'))).catch((e: unknown) => e);
    expect((err as ApiAgentError).kind).toBe('auth');
    expect((err as Error).message).toContain('rejected MAILBOX_TOKEN (401)');
  });

  it('fails each turn with a sentence when there is no token', async () => {
    const { backend } = rig(undefined, { token: '' });
    await expect(collect(backend.turn(request('q')))).rejects.toThrow(/MAILBOX_TOKEN is not set/);
  });
});

describe('attachments', () => {
  it('sends the text only and says the attachments did not go', async () => {
    const { backend, relay } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'final', 'read it');
      }
    });
    const prompt = `look at this${ATTACHMENTS_MARKER}[Attachment shot.png: /tmp/a/shot.png (image/png)]`;
    const events = await collect(backend.turn(request(prompt)));
    expect(relay.sent[0]?.text).toBe('look at this');
    expect(textOf(events)).toBe('(Attachments cannot go through the mailbox; only the text was sent.)\n\nread it');
  });

  it('sends nothing when there is no text besides them', async () => {
    const { backend, relay } = rig();
    const events = await collect(backend.turn(request(`${ATTACHMENTS_MARKER}[Attachment a.pdf: /tmp/a.pdf]`)));
    expect(relay.sent).toEqual([]);
    expect(textOf(events)).toContain('nothing was sent');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('matches how the gateway appends them (daemon/turn-runner.ts buildPrompt)', () => {
    const source = readFileSync(path.join(import.meta.dirname, '../daemon/turn-runner.ts'), 'utf8');
    expect(source).toContain('`${base}\\n\\n---\\nAttachments:\\n${promptText}`');
    expect(splitAttachments(`a${ATTACHMENTS_MARKER}b`)).toEqual({ text: 'a', attachments: true });
    expect(splitAttachments('plain')).toEqual({ text: 'plain', attachments: false });
  });
});

describe('stop', () => {
  it('stops the local turn, and cancel() queues a cancel for a picked-up message', async () => {
    const ctl = new AbortController();
    const { backend, relay } = rig((t, r) => {
      if (t === 2_000) r.agentPoll();
      if (t === 6_000) ctl.abort(new Error('stopped'));
    });
    const events: BackendEvent[] = [];
    const err = await (async () => {
      for await (const e of backend.turn(request('long job', ctl.signal))) events.push(e);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(events).toEqual([{ type: 'state', lastInteractionId: 't1' }]);
    await backend.cancel('t1', 'sess-1');
    expect(relay.cancels).toEqual([{ session: 'sess-1', turn: 't1', withdraw_only: false }]);
    expect(relay.inbox.at(-1)).toMatchObject({ type: 'cancel', turn: 't1' });
  });

  it('withdraws a message nobody picked up yet', async () => {
    const { backend, relay } = rig();
    relay.inbox.push({ seq: 1, session: 'sess-1', turn: 't1', type: 'message', text: 'x' });
    await backend.cancel('t1', 'sess-1');
    expect(relay.inbox).toEqual([]);
  });
});

describe('between turns', () => {
  it('shows what waited in the relay at the start of the next turn, progress left out', async () => {
    const { backend, relay } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'final', 'new answer');
      }
    });
    // Left by a turn this process never saw: before a gateway restart, or while the child was gone.
    relay.agentReply('sess-1', 't0', 'progress', 'old progress');
    relay.agentReply('sess-1', 't0', 'final', 'the old answer');
    relay.agentReply('sess-1', null, 'message', 'also: the build finished');
    relay.agentReply('other', null, 'message', 'not this session');
    const events = await collect(backend.turn(request('next question')));
    expect(textOf(events)).toBe(
      '⏱ Earlier replies not shown yet:\n\nthe old answer\n\nalso: the build finished\n\n---\n\nnew answer',
    );
    expect(relay.replies.map((r) => r.text)).toEqual(['not this session']);
  });

  it('follow() delivers a late reply as text plus settled, and a turn pauses it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { backend, relay } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't1', 'final', 'done');
      }
    }, { idlePollMs: 5_000 });
    await collect(backend.turn(request('q')));
    const emitted: BackendEvent[] = [];
    backend.follow!('sess-1', async (e) => {
      emitted.push(e);
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(emitted).toEqual([]);
    relay.agentReply('sess-1', null, 'message', 'background job finished');
    relay.agentReply('sess-1', 't1', 'progress', 'stale progress');
    relay.agentReply('sess-1', null, 'message', 'second note');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emitted).toEqual([
      { type: 'text', text: 'background job finished' },
      { type: 'text', text: '\n\nsecond note' },
      { type: 'settled' },
    ]);
    // Confirmed: the next poll does not deliver them again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emitted).toHaveLength(3);
    backend.close!();
    relay.agentReply('sess-1', null, 'message', 'after close');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(emitted).toHaveLength(3);
  });

  it('a reply for another turn read during a turn is delivered after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { backend } = rig((t, r) => {
      if (t === 2_000) {
        r.agentPoll();
        r.agentReply('sess-1', 't0', 'final', 'late answer to the stopped turn');
        r.agentReply('sess-1', 't1', 'final', 'this answer');
      }
    });
    const emitted: BackendEvent[] = [];
    backend.follow!('sess-1', async (e) => {
      emitted.push(e);
    });
    const events = await collect(backend.turn(request('q')));
    expect(textOf(events)).toBe('this answer');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(emitted).toEqual([{ type: 'text', text: 'late answer to the stopped turn' }, { type: 'settled' }]);
    backend.close!();
  });
});

describe('formatting', () => {
  it('joins pieces without doubling breaks', () => {
    expect(joinText('a', 'b')).toBe('\n\nb');
    expect(joinText('a\n', 'b')).toBe('\nb');
    expect(joinText('a\n\n', 'b')).toBe('b');
  });

  it('says durations the way a person would', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(16 * 60_000)).toBe('16 min');
    expect(formatDuration(5 * 3_600_000 + 5 * 60_000)).toBe('5h 5m');
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h');
  });
});
