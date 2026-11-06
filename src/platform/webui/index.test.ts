import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import { PAGE_SIZE, PAGE_SIZE_MAX, resolvePageSize } from '../../core/paging.js';
import { WebuiConfigSchema } from '../config-schemas.js';
import { createWebuiAdapter, diskTranscriptStore, diskUploadStore } from './index.js';
import { CHANNEL, type Kept } from './room.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { PlatformAdapter } from '../adapter.js';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-adapter-'));
  saved = process.env.TALKCODE_CONFIG_DIR;
  process.env.TALKCODE_CONFIG_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TALKCODE_CONFIG_DIR;
  else process.env.TALKCODE_CONFIG_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

function adapter(): PlatformAdapter {
  return createWebuiAdapter({ ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui' });
}

/** The adapter opens one topic on a fresh install; this is how a test gets an address into it. */
async function somewhere(a: PlatformAdapter): Promise<ConversationAddress> {
  const { address } = await a.createThread({ address: { channel: CHANNEL }, messageId: '' }, 'a topic');
  return address;
}

describe('webui adapter: what it says it can do', () => {
  it('declares topics, and that they can be named', () => {
    const caps = adapter().capabilities;
    expect(caps.thread).toBe(true);
    // A topic here is made from nothing, so a scheduled run with no message can open one — what
    // the daily-session registration gate asks (capabilities.standaloneThread).
    expect(caps.standaloneThread).toBe(true);
    // Only true because a topic IS a lane: `retitleLane` refuses any address without one, so
    // the channel-per-topic alternative would have left this permanently inert.
    expect(caps.renameThread).toBe(true);
  });

  it('declares the largest menu page core allows', () => {
    // More than the chat platforms' 12 on purpose: the page lays a menu out as a grid, so a page
    // here costs a fraction of the rows it does there. Equal to the ceiling and not past it, or core
    // would quietly draw a smaller page than this adapter believes it asked for.
    const size = adapter().capabilities.menuPageSize;
    expect(size).toBe(PAGE_SIZE_MAX);
    expect(size).toBeGreaterThan(PAGE_SIZE);
    expect(resolvePageSize(size)).toBe(size);
  });

  it('asks the pacer for a budget per topic, not one for the whole page', () => {
    // Every topic is a lane on the one channel: on a shared budget a menu tap in a quiet topic
    // queued behind every other topic's streaming (daemon/paced-adapter.ts).
    expect(adapter().capabilities.paceByLane).toBe(true);
  });

  it('claims buttons AND editButtons, without which /model, /cd and /setting degrade to text', () => {
    const caps = adapter().capabilities;
    expect(caps.buttons).toBe(true);
    expect(caps.editButtons).toBe(true);
  });

  it('leaves the per-message edit budget unset, because nothing here refuses an edit', () => {
    expect(adapter().capabilities.maxEditsPerMessage).toBeUndefined();
  });

  it('declares its typing a state, so the pacer never drops the start that lights the dot', () => {
    expect(adapter().capabilities.typingUntilStopped).toBe(true);
  });

  it('asks for whole commands in its tool bubbles, which the page folds itself', () => {
    // Far above the operator default (40), or the page's "Show all" would open a line onto the
    // same cut-off command it was already showing.
    const limit = adapter().capabilities.toolPreviewLimit ?? 0;
    expect(limit).toBeGreaterThanOrEqual(1_000);
    // ...and still under one message, so a single line can never be what seals a bubble.
    expect(limit).toBeLessThan(adapter().capabilities.maxMessageLength);
  });

  it('measures the raw markdown, never the html it renders', () => {
    // maxMessageLength bounds the text the writer is chunking. Measuring the rendered html
    // would make a fenced code block read several times its real size and chop replies at a
    // fraction of the stated limit for no reason.
    const src = '```\nconst a = 1 < 2 && 3 > 2;\n```';
    expect(adapter().measureRendered(src)).toBe(src.length);
  });
});

describe('webui adapter: topics', () => {
  it('opens a topic and returns it as a lane', async () => {
    const a = adapter();
    const address = await somewhere(a);
    // The shape `adapter.ts` documents for a platform whose threads are lanes, and what
    // `--channel main/<id>` parses back to.
    expect(address).toEqual({ channel: CHANNEL, thread: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string });
  });

  it('names a topic', async () => {
    const a = adapter();
    const address = await somewhere(a);
    // The string the automatic namer produces (`formatLaneTitle`), which is what actually
    // arrives here in a real turn.
    await expect(a.renameThread(address, '[cc] fix the login timeout')).resolves.toBeUndefined();
  });

  it('refuses an address that is not one of its topics', async () => {
    const a = adapter();
    // A `--channel` override on a reverse command is how this happens. Posting it into
    // whichever room happened to be first would be the wrong kind of helpful.
    await expect(a.sendMessage({ channel: 'elsewhere', thread: 'x' }, 'x')).rejects.toThrow(/addresses topics as/);
    await expect(a.sendMessage({ channel: CHANNEL }, 'x')).rejects.toThrow(/addresses topics as/);
    await expect(a.sendMessage({ channel: CHANNEL, thread: 'deadbeef' }, 'x')).rejects.toThrow(/no such topic/);
  });

  it('keeps each topic history to itself', async () => {
    const a = adapter();
    const one = await somewhere(a);
    const two = await somewhere(a);
    await a.sendMessage(one, 'in one');
    expect((await a.fetchHistory(one, {})).map((m) => m.content)).toEqual(['in one']);
    expect(await a.fetchHistory(two, {})).toEqual([]);
  });

  it('marks a topic a scheduled run opened, and only that one', async () => {
    // The page reads this flag off the topic list to keep the run out of the switcher and in the
    // panel's Sessions tab; it has to survive in the file, not just in memory.
    const a = adapter();
    const run = await a.createThread({ address: { channel: CHANNEL }, messageId: '' }, '[cc] ⏰ run', { scheduled: true });
    const normal = await somewhere(a);

    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'webui-topics-webui.json'), 'utf8')) as Record<
      string,
      { scheduled?: boolean }
    >;
    expect(stored[run.address.thread!]?.scheduled).toBe(true);
    expect(stored[normal.thread!]).not.toHaveProperty('scheduled');
  });

  it('shows a status strip, and refuses one for an address that is not its topic', async () => {
    // The one platform that implements setStatus. It throws on a bad address like every outbound
    // method here; the daemon's status board is what swallows that.
    const a = adapter();
    expect(typeof a.setStatus).toBe('function');
    const address = await somewhere(a);
    expect(() => a.setStatus!(address, { agent: 'cc' })).not.toThrow();
    expect(() => a.setStatus!({ channel: CHANNEL, thread: 'deadbeef' }, { agent: 'cc' })).toThrow(/no such topic/);
  });
});

describe('webui adapter: outbound', () => {
  it('sends, edits and deletes through one stable ref', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendMessage(address, 'hello');
    expect(ref.address).toEqual(address);
    await expect(a.editMessage(ref, 'hello again')).resolves.toBeUndefined();
    await expect(a.deleteMessage(ref)).resolves.toBeUndefined();
    // Deleted, so no longer editable — and it says so in the vocabulary the writers understand.
    await expect(a.editMessage(ref, 'x')).rejects.toBeInstanceOf(MessageNotEditableError);
  });

  it('posts buttons and retires them with an empty list', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendButtons(address, 'Pick one', [{ id: 'ask:r:0', label: 'Yes' }]);
    await expect(a.editButtons(ref, 'Pick one\n\nanswered', [])).resolves.toBeUndefined();
  });

  it('marks a dispatch and a report, and renders a report one line per row so the page can fold it', async () => {
    // What `delegation.ts` sends: the card and the task a sub-agent is handed are dispatches; its
    // `[sub-agent updates]` card is a report. The mark has to survive the send, and a report's
    // lines have to reach the page as rows — markdown would merge them into one paragraph and
    // there would be nothing left to fold.
    const a = adapter();
    const address = await somewhere(a);
    await a.sendMessage(address, '**↳ From [Parent](?t=aaaaaaaa)**\n\ndo the thing', { kind: 'dispatch' });
    await a.sendMessage(address, '🔔 a (cc) — finished: done.', { kind: 'report' });
    await a.sendButtons(address, 'wants to start a sub-agent', [{ id: 'ask:r:0', label: 'Start it' }], undefined, {
      kind: 'dispatch',
    });
    // Buttons and a line-based kind together: still rows, so the page never shows a "Show all"
    // over a body that has no `.tl` to open.
    await a.sendButtons(address, '🔔 a (cc) — done.', [{ id: 'ask:r:1', label: 'OK' }], undefined, { kind: 'report' });
    await a.stop();

    const at = path.join(dir, 'webui-transcripts-webui', `${address.thread ?? ''}.json`);
    const written = JSON.parse(fs.readFileSync(at, 'utf8')) as Kept[];
    expect(written.map((k) => k.msg.kind)).toEqual(['dispatch', 'report', 'dispatch', 'report']);
    // A dispatch is prose (the card, or the task text) and stays markdown; a report is rows.
    expect(written[0]?.msg.html).not.toContain('class="tl"');
    expect(written[1]?.msg.html).toContain('<div class="tools"><div class="tl">');
    expect(written[3]?.msg.html).toContain('<div class="tools"><div class="tl">');
    // And the transcript store carries the kinds across a restart, which is what a reload paints.
    const restored = diskTranscriptStore(path.dirname(at)).load().get(address.thread ?? '') ?? [];
    expect(restored.map((k) => k.msg.kind)).toEqual(['dispatch', 'report', 'dispatch', 'report']);
  });

  it('quotes the message a reply answers', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const target = await a.sendMessage(address, 'the question');
    await expect(a.replyMessage(target, 'the answer')).resolves.toMatchObject({ address });
  });

  it('takes reactions and typing without complaint, since nothing gates them', async () => {
    // The daemon never reads capabilities.reaction or .typing — it calls these unconditionally
    // and swallows failures. So the real obligation is that they are safe to call.
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendMessage(address, 'x');
    await expect(a.addReaction(ref, '👀')).resolves.toBeUndefined();
    await expect(a.removeReaction(ref, '👀')).resolves.toBeUndefined();
    await expect(a.startTyping(address)).resolves.toBeUndefined();
    await expect(a.stopTyping(address)).resolves.toBeUndefined();
  });

  it('publishes a sent file behind a token rather than its path', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const source = path.join(dir, 'report.pdf');
    fs.writeFileSync(source, 'pdf bytes');
    const ref = await a.sendFile(address, { path: source, name: 'report.pdf' });
    expect((await a.fetchHistory(address, {})).some((m) => m.messageId === ref.messageId)).toBe(true);
  });

  it('keeps its own copy of a sent file, so the download outlives the path it came from', async () => {
    // What a remote agent's send-file looks like from here: the daemon fetches the file into a
    // temporary one and removes it as soon as sendFile returns (daemon.ts sendAgentFile).
    const a = adapter();
    const address = await somewhere(a);
    const tmp = fs.mkdtempSync(path.join(dir, 'talkcode-file-'));
    const source = path.join(tmp, 'pushme.apk');
    fs.writeFileSync(source, 'apk bytes', { mode: 0o644 });
    await a.sendFile(address, { path: source, name: 'pushme.apk' });
    fs.rmSync(tmp, { recursive: true, force: true });
    const kept = path.join(dir, 'webui-uploads-webui');
    const files = fs.readdirSync(kept);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(kept, files[0]!), 'utf8')).toBe('apk bytes');
  });

  it('fails a send-file whose path cannot be read, instead of publishing a link to nothing', async () => {
    const a = adapter();
    const address = await somewhere(a);
    await expect(a.sendFile(address, { path: path.join(dir, 'nope.pdf') })).rejects.toThrow(/ENOENT/);
    expect((await a.fetchHistory(address, {})).length).toBe(0);
  });

  it('offers the reader for a file it can render, and for no other', async () => {
    const a = adapter();
    const address = await somewhere(a);
    for (const name of ['plan.md', 'report.pdf']) {
      fs.writeFileSync(path.join(dir, name), 'bytes');
      await a.sendFile(address, { path: path.join(dir, name), name });
    }
    // Read back from the transcript `stop` writes: the message as the page was sent it.
    await a.stop();
    const at = path.join(dir, 'webui-transcripts-webui', `${address.thread ?? ''}.json`);
    const written = JSON.parse(fs.readFileSync(at, 'utf8')) as Kept[];
    const [md, pdf] = written.map((k) => k.msg.file);
    expect(md?.view).toBe(md?.url.replace(/^f\//, 'view/'));
    expect(pdf?.name).toBe('report.pdf');
    expect(pdf?.view).toBeUndefined();
    // And not carried across a restart, whose download table no longer knows the token.
    const restored = diskTranscriptStore(path.dirname(at)).load().get(address.thread ?? '') ?? [];
    expect(restored[0]?.msg.file).toEqual({ name: 'plan.md', url: md?.url });
  });

  it('accepts all three inbound registrations, including the one it never calls', () => {
    // The daemon wires onMessage/onButton/onCommand on every adapter before starting it, so
    // refusing the slash-interaction one would fail Daemon.run() — even though a slash command
    // reaches this platform as an ordinary message and no interaction is ever emitted.
    const a = adapter();
    expect(() => {
      a.onMessage(() => {});
      a.onButton(() => {});
      a.onCommand(() => {});
    }).not.toThrow();
  });

  it('remembers its topics across a restart', async () => {
    const first = adapter();
    const address = await somewhere(first);
    // A second adapter over the same config dir is what a daemon restart looks like from here.
    await expect(adapter().sendMessage(address, 'still there')).resolves.toBeDefined();
  });
});

describe('webui adapter: where the operator\'s pictures and the agent\'s files are kept', () => {
  it('writes one under a name of its own, readable once `ready` settles, and deletes it on discard', async () => {
    const at = path.join(dir, 'uploads');
    const store = diskUploadStore(at);
    const { path: file, ready } = store.save('../../etc/evil name.PNG', Buffer.from('picture bytes').toString('base64'));
    // The browser's name never becomes a path: only its extension survives, lowercased.
    expect(path.dirname(file)).toBe(at);
    expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}\.png$/);
    await ready;
    expect(fs.readFileSync(file, 'utf8')).toBe('picture bytes');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.discard(file);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('starts empty: what an earlier run kept, no download table can reach any more', async () => {
    const at = path.join(dir, 'uploads');
    const first = diskUploadStore(at);
    const { path: file, ready } = first.save('a.png', 'AAAA');
    await ready;
    expect(fs.existsSync(file)).toBe(true);
    diskUploadStore(at);
    expect(fs.existsSync(at)).toBe(false);
  });

  it('settles `ready` even when the write fails, so a download waiting on it is answered', async () => {
    // A FILE where the directory should be: mkdir fails, and the failure must not become a rejection
    // nobody handles — the download that awaits this answers 404 instead.
    const at = path.join(dir, 'not-a-dir');
    const store = diskUploadStore(at);
    fs.writeFileSync(at, 'x');
    await expect(store.save('a.png', 'AAAA').ready).resolves.toBeUndefined();
  });

  it('copies an agent\'s file under a name of its own, owner-only whatever the source was', async () => {
    const at = path.join(dir, 'uploads');
    const store = diskUploadStore(at);
    const source = path.join(dir, 'report of the week.pdf');
    fs.writeFileSync(source, 'report bytes', { mode: 0o644 });
    const file = await store.copy(source);
    expect(path.dirname(file)).toBe(at);
    expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('report bytes');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The source is only read.
    expect(fs.readFileSync(source, 'utf8')).toBe('report bytes');
  });

  it('rejects a copy it cannot make, and leaves nothing behind', async () => {
    const at = path.join(dir, 'uploads');
    const store = diskUploadStore(at);
    await expect(store.copy(path.join(dir, 'gone.pdf'))).rejects.toThrow(/ENOENT/);
    await expect(store.copy(dir)).rejects.toThrow();
    expect(fs.readdirSync(at)).toEqual([]);
  });
});

describe('webui adapter: where a topic keeps its transcript', () => {
  const kept = (id: string, extra: Record<string, unknown> = {}): Kept => ({
    text: `text of ${id}`,
    msg: { id, own: false, html: `<p>${id}</p>`, at: 1, g: 42, buttons: [], reactions: ['✅'], ...extra },
  });

  it('writes a topic to a file of its own that only the operator can read, and reads it back', () => {
    const at = path.join(dir, 'transcripts');
    const store = diskTranscriptStore(at);
    store.save('a1b2c3d4', [
      kept('w1', { nonce: 'n1', kind: 'tools' }),
      kept('w2'),
      kept('w3', { kind: 'dispatch' }),
      kept('w4', { kind: 'report' }),
    ]);

    const file = path.join(at, 'a1b2c3d4.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(at).mode & 0o777).toBe(0o700);
    // No temporary file left beside it: the write is a rename.
    expect(fs.readdirSync(at)).toEqual(['a1b2c3d4.json']);
    expect(diskTranscriptStore(at).load().get('a1b2c3d4')).toEqual([
      kept('w1', { nonce: 'n1', kind: 'tools' }),
      kept('w2'),
      kept('w3', { kind: 'dispatch' }),
      kept('w4', { kind: 'report' }),
    ]);

    store.drop('a1b2c3d4');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('carries across only what a message is, and passes over a file it cannot read', () => {
    const at = path.join(dir, 'transcripts');
    fs.mkdirSync(at);
    fs.writeFileSync(
      path.join(at, 'a1b2c3d4.json'),
      JSON.stringify([
        { text: 'ok', msg: { ...kept('w1').msg, buttons: [{ id: 'b', label: 'stale' }], onclick: 'x' } },
        { text: 'no run', msg: { id: 'w2', own: false, html: '<p>x</p>', at: 1 } },
        'not a message',
      ])
    );
    fs.writeFileSync(path.join(at, 'b2c3d4e5.json'), '{ torn');
    fs.writeFileSync(path.join(at, 'not-a-topic.json'), '[]');

    const loaded = diskTranscriptStore(at).load();

    expect([...loaded.keys()]).toEqual(['a1b2c3d4']);
    // Buttons are never restored, and nothing outside WebMessage's own fields rides along.
    expect(loaded.get('a1b2c3d4')).toEqual([{ ...kept('w1'), text: 'ok' }]);
  });

  it('comes back after the adapter is built again, for a starred topic', async () => {
    const first = adapter();
    const where = await somewhere(first);
    await first.sendMessage(where, 'said before the restart');
    const topics = path.join(dir, 'webui-topics-webui.json');
    // Starred the way the page does it, through the store the adapter persists.
    const saved = JSON.parse(fs.readFileSync(topics, 'utf8')) as Record<string, { starred?: boolean }>;
    saved[where.thread!]!.starred = true;
    fs.writeFileSync(topics, JSON.stringify(saved));
    // A second adapter reads the star; its first change writes the kept transcript.
    const second = adapter();
    await second.sendMessage(where, 'said in the second run');
    await second.stop();

    const third = adapter();
    const history = await third.fetchHistory!(where, { limit: 10 });
    expect(history.map((m) => m.content)).toEqual(['said in the second run']);
  });
});
