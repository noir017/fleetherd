/**
 * The HTTP surface of the web UI: the page, the event stream, four small POSTs, and a door to
 * the terminal pane's backend.
 *
 * Plain `node:http`, and plain server-sent events rather than a WebSocket. Node has no
 * WebSocket server of its own, so that choice would mean a new dependency for one local page —
 * while SSE needs nothing on either side (`EventSource` is built into every browser, reconnects
 * by itself, and hands back the last id it saw) and the upstream direction is four ordinary
 * POSTs. The only thing given up is client→server streaming, which nothing here wants.
 *
 * A WebSocket does cross this server, for the terminal — but only as bytes. It is proxied to
 * ttyd frame-unaware (`terminal-proxy.ts`), so that still costs no dependency and no protocol
 * code here. What it does cost is a second gate: see `upgrade()`.
 *
 * ── This is a trust boundary ─────────────────────────────────────────────────
 * The port is bound to every interface by default and the thing behind it is an agent with
 * full tool access. So: every body is validated by a `.strict()` zod schema in `protocol.ts`
 * and never cast; every route but the page and the login itself requires a session cookie; a
 * file the agent sent is reachable only through an opaque token, never a path; and anything
 * downloaded is served `attachment` + `nosniff` so an agent-sent `.html` can never execute on
 * this origin — the reader (`view`) shows HTML this daemon built from a file, never the file.
 *
 * ── Built for a weak link ────────────────────────────────────────────────────
 * Everything compressible is compressed, including the event stream — which is the part with a
 * trap in it: a gzip stream buffers until it is told not to, so each event is followed by an
 * explicit `Z_SYNC_FLUSH`. Without that the page receives nothing at all until the connection
 * closes, which is indistinguishable from a hung daemon and is exactly the failure this pass
 * exists to prevent. `server.test.ts` pins it.
 *
 * A reconnect resumes: the browser sends `Last-Event-ID`, and the room replays only what that
 * client missed instead of the whole conversation. See `room.ts`.
 *
 * ── Shutting down ────────────────────────────────────────────────────────────
 * `stop()` is on the daemon's exit path: `Daemon.stop()` awaits it, and the signal handler only
 * calls `process.exit` in that promise's `finally`. `server.close()` alone would never return
 * here — its callback waits for every connection to end, and an event stream by definition
 * never does. So `stop()` ends the streams itself (gzip stream included, not just the
 * response), then closes connections, with a timeout as a backstop. Getting this wrong does not
 * leak a socket; it hangs Ctrl-C forever.
 */
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { brotliCompress, constants as zlibConstants, createGzip, gzip, gzipSync } from 'node:zlib';

import type { InstructionsPanel, InstructionsTarget } from '../adapter.js';
import { ASSET_FILE, loadAssets, type WebAssets } from './assets.js';
import { SESSION_COOKIE, readCookie, sessionCookie, type WebAuth } from './auth.js';
import { ICON_PNG, ICON_SVG, renderManifest } from './manifest.js';
import { servePage, type PageAssets } from './page.js';
import {
  ClickRequestSchema,
  CreateTopicRequestSchema,
  ClearTopicsRequestSchema,
  CloseIdleRequestSchema,
  KillTopicRequestSchema,
  DeleteTopicRequestSchema,
  EndTerminalRequestSchema,
  FramedSendHeaderSchema,
  GitCommitFileQuerySchema,
  GitCommitQuerySchema,
  GitFileQuerySchema,
  GitLogQuerySchema,
  GitStatusQuerySchema,
  LoginRequestSchema,
  MAX_BODY_BYTES,
  SendRequestSchema,
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  ScheduleAddRequestSchema,
  ScheduleEditRequestSchema,
  ScheduleOpRequestSchema,
  ScheduleTaskId,
  ModelChooseRequestSchema,
  OptionChooseRequestSchema,
  SeenRequestSchema,
  SkillOpRequestSchema,
  ReviewOpRequestSchema,
  FilesWriteRequestSchema,
  FilesCreateRequestSchema,
  FilesRenameRequestSchema,
  FilesRemoveRequestSchema,
  InstructionsWriteRequestSchema,
  StarTopicRequestSchema,
  TOPIC_ID,
  parseBody,
  type SendRequest,
  type WebEvent,
} from './protocol.js';
import { MAX_READ_BYTES, readableKind, renderReading } from './reading.js';
import { inlineImageType, type WebRoom, type WebuiInstance } from './room.js';
import type { SsoRefusal, WebSso } from './sso.js';
import { proxyRequest, proxyUpgrade, type UpstreamSet } from './terminal-proxy.js';
import type { TerminalSessions } from './terminal-sessions.js';
import { SERVICE_WORKER } from './sw.js';
import type { WebPush } from './webpush.js';

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Where the terminal pane's ttyd is, whether the pane exists, and its session bookkeeping. */
export interface TerminalSettings {
  enabled: boolean;
  /** Resolved by `index.ts`; meaningless when `enabled` is false. */
  socket: string;
  /**
   * Who is attached and how a session ends — see `terminal-sessions.ts`.
   *
   * A live object riding along with two config values, because `index.ts` is where both ends
   * of it meet: this server feeds it (every proxied handshake) and the room reads it (the
   * topic list's marker). Constructing it here instead would leave the room with nothing to
   * read, and making it a sixth parameter would separate it from the two settings it is
   * meaningless without.
   */
  sessions: TerminalSessions;
}

/** Keeps proxies and NAT tables from dropping an idle stream. A comment line, not an event. */
const HEARTBEAT_MS = 25_000;

/** How long `stop()` waits for connections to end before destroying them. */
const SHUTDOWN_GRACE_MS = 2_000;

/** Below this, gzip's own framing costs more than it saves. */
const MIN_COMPRESS_BYTES = 512;

/**
 * How far behind an event stream may fall — bytes written here that have not yet reached the
 * socket — and for how long, before the connection is cut.
 *
 * Without a bound, nothing ever stopped writing to a client that had stopped reading: every write's
 * return value was dropped, and whatever the socket would not take was held in this process. A
 * phone put down with the page open is that client, and a busy daemon has plenty to send it — the
 * topic list alone (~70 KB at 200 topics) goes to every client on every message posted anywhere.
 * Measured 2026-11-07: one stream that had stopped reading held 153 MB after 2000 posts, and was
 * never let go.
 *
 * Both halves, not the byte count alone, because one event can be larger than any sensible cap: a
 * full `sync` of a long topic is ~3 MB of JSON, and on a slow link it takes a while to drain. Cut
 * on bytes alone, that client would reconnect without a resume point, be sent the same sync, and be
 * cut again — for ever. So a stream may be over the cap for a while and is only cut when it stays
 * over it: a client that is draining a big sync gets under it, a client that has stopped reading
 * does not.
 *
 * Cutting loses nothing. The page's `EventSource` reconnects by itself with the last id it received,
 * and the room hands it what it missed — or a full sync, if its backlog no longer reaches that far.
 * Counted in bytes before compression where there is compression (what the room wrote, which is
 * what this process holds), plus the compressed bytes still in this process.
 */
const MAX_BEHIND_BYTES = 2 * 1024 * 1024;
const MAX_BEHIND_MS = 60_000;

/** How rarely an identical SSO refusal is repeated in the log, and how many are tracked. */
const REFUSAL_QUIET_MS = 60_000;
const MAX_WARN_KEYS = 256;

/** One attached event stream, with whatever sits between it and the socket. */
interface Stream {
  /** A no-op once the stream has been cut for falling behind (see `MAX_BEHIND_BYTES`). */
  write(chunk: string): void;
  end(): void;
}

export function createWebServer(
  room: WebRoom,
  auth: WebAuth,
  instance: WebuiInstance,
  terminal: TerminalSettings,
  sso?: WebSso,
  push?: WebPush,
  assets: WebAssets = loadAssets()
): WebServer {
  const sockets = new Set<Socket>();
  const streams = new Set<Stream>();
  const upstreams: UpstreamSet = new Set<Socket>();
  const ctx: Ctx = { room, auth, instance, streams, terminal, upstreams, sso, push, assets, warned: new Map() };

  const server = createServer((req, res) => {
    void route(req, res, ctx).catch((e: unknown) => {
      console.error('[webui] request failed:', e instanceof Error ? (e.stack ?? e.message) : e);
      if (!res.headersSent) send(req, res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // An upgrade NEVER reaches the request handler above, so it never reaches `route()` — which
  // means the OPEN/GUARDED tables, the session check and the origin check all simply do not
  // apply to it. A WebSocket route added by editing those tables would be wide open and look
  // protected. Hence a second, deliberate gate; see `upgrade()`.
  server.on('upgrade', (req, socket, head) => upgrade(req, socket as Socket, head, ctx));

  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': ping\n\n');
  }, HEARTBEAT_MS);
  // Unref'd so this interval can never be the reason the process stays alive — `daemon.stop()`
  // is called directly by several tests, and a live timer there hangs the runner.
  heartbeat.unref();

  return {
    start: () => listen(server, instance, room),
    stop: () => shutdown(server, streams, sockets, upstreams, heartbeat),
  };
}

function listen(server: Server, instance: WebuiInstance, room: WebRoom): Promise<void> {
  return new Promise((resolve, reject) => {
    // A bind failure arrives as an 'error' EVENT, asynchronously — not as a throw from listen().
    // Without this, EADDRINUSE would surface as the daemon's global [uncaughtException] handler
    // and the daemon would run on with a dead UI and no clue why.
    const onError = (e: Error): void => {
      server.off('listening', onListening);
      reject(new Error(`[webui] cannot bind ${instance.host}:${instance.port}: ${e.message}`));
    };
    const onListening = (): void => {
      server.off('error', onError);
      server.on('error', (e) => console.error('[webui] server error:', e.message));
      announce(instance, room);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(instance.port, instance.host);
  });
}

/**
 * Say where it is listening and what is, and is not, protecting it.
 *
 * The loud version when the bind is not loopback, because that is a security posture the
 * operator chose in one line of YAML and will not otherwise be reminded of: there is no TLS
 * here, and the shared secret is the whole of the door. An `sso:` block changes what that
 * sentence should say but not whether it is worth saying — the port is still open to whatever
 * can reach it, and the proxy's assertion is only checked on requests that arrive from `from`.
 */
function announce(instance: WebuiInstance, room: WebRoom): void {
  const where = `http://${instance.host}:${instance.port}`;
  console.log(
    `[webui] "${instance.id}" listening on ${where} — ${room.topics.list().length} topic(s), ${room.watchers} client(s) attached`
  );
  if (instance.sso) {
    console.log(
      `[webui] "${instance.id}" accepts ${instance.sso.header} from ${instance.sso.from.join(', ')} for ` +
        `${instance.sso.allow.length} identitie(s); password login is ` +
        `${instance.sso.password ? 'also accepted' : 'OFF'}`
    );
  }
  if (instance.host !== '127.0.0.1' && instance.host !== 'localhost' && instance.host !== '::1') {
    console.warn(
      `[webui] "${instance.id}" is reachable from the network and speaks plain HTTP: ` +
        `${instance.sso ? 'the proxy assertion and the shared token are' : 'the shared token is'} ` +
        `the only thing between it and an agent with full tool access. Put TLS in front ` +
        `of it before exposing it beyond a network you control, or bind host: 127.0.0.1 and tunnel.`
    );
  }
}

async function shutdown(
  server: Server,
  streams: Set<Stream>,
  sockets: Set<Socket>,
  upstreams: UpstreamSet,
  heartbeat: NodeJS.Timeout
): Promise<void> {
  clearInterval(heartbeat);
  for (const stream of streams) {
    // Tell the page to stop reconnecting BEFORE dropping it; see the `bye` event's doc. `end()`
    // finishes the gzip stream where there is one — ending only the response would leave the
    // compressor's tail unwritten and the socket open.
    try {
      stream.write(`data: ${JSON.stringify({ t: 'bye' } satisfies WebEvent)}\n\n`);
      stream.end();
    } catch {
      // Already gone. Nothing to do and nothing worth logging on the way out.
    }
  }
  streams.clear();
  // Same reason the streams above are ended by hand, one hop further out: a live proxy to ttyd
  // is a connection `server.close()` would wait on forever, and it is not one of ours to wait
  // for. The downstream half is in `sockets` already; this is the half pointing at ttyd.
  for (const upstream of upstreams) upstream.destroy();
  upstreams.clear();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      finish();
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => finish());
    server.closeIdleConnections();
    server.closeAllConnections();
  });
  sockets.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  room: WebRoom;
  auth: WebAuth;
  instance: WebuiInstance;
  streams: Set<Stream>;
  terminal: TerminalSettings;
  upstreams: UpstreamSet;
  /** The second door, when an identity-aware proxy sits in front. See `sso.ts`. */
  sso?: WebSso;
  /** Last time each (reason, source) refusal was logged; see `noteRefusal`. */
  warned: Map<string, number>;
  /** Push notifications (webpush.ts); absent in a test that does not care, which then offers none. */
  push?: WebPush;
  /** The built code view, if a build ever ran — see `assets.ts`. */
  assets: WebAssets;
  /** The page as last served — see `servedPage`. */
  page?: ServedPage;
}

/**
 * The page document, rendered once per configuration, with its validator and its compressed form.
 *
 * Every load used to render it (3.7 ms) and gzip it (16.4 ms) again on the event loop, and send all
 * of it: 455 KB, 134 KB on the wire — 2.6 s on a 500 kbps link, for bytes that only change when the
 * daemon is upgraded. Now the browser keeps it and asks before using it (`no-cache`), and the answer
 * is a 304 unless the rendered bytes changed. The validator is the page's build — a hash of what
 * `servePage` rendered — rather than a version number, so an upgrade, a new title or a terminal
 * turned on all produce a new page at the next load without anyone having to remember to bump
 * anything, and the page itself carries the same hash to compare with after a restart.
 */
interface ServedPage {
  /** The render inputs this entry was made from; a different set renders again. */
  key: string;
  raw: Buffer;
  gzip: Buffer;
  /**
   * The same page as brotli at quality 11 — 18% smaller than gzip (113 KB against 138 KB) — once it
   * is ready. That quality takes about a second, which is why it is only ever made for this cached
   * page, on the thread pool, and never per request (`brotliPage`): until it lands, a client that
   * takes br is sent gzip. The event stream stays gzip, flushed per event (see `openStream`).
   */
  br?: Buffer;
  /** `brotliPage` has started on this entry. */
  brotli?: boolean;
  /**
   * Weak, because the same validator stands for every encoding of it: they are the same page, and
   * `If-None-Match` compares weakly anyway. A strong tag would also oblige a proxy that
   * re-compresses (Cloudflare does) to drop it.
   */
  etag: string;
}

/** One request, already parsed as far as routing needs it. */
interface Req {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The part of the path a prefix route did not match. */
  rest: string;
}

interface Route {
  method: string;
  path: string;
  prefix?: boolean;
  /**
   * Which of the names under a prefix this entry answers; the rest go on down the tables as if it
   * were not there. How one prefix can be open for two files and guarded for everything else.
   */
  only?: (rest: string, ctx: Ctx) => boolean;
  run: (rq: Req, ctx: Ctx) => Promise<void> | void;
}

/** Reachable without a session: the page itself, and the exchange that gets you one. */
const OPEN: Route[] = [
  { method: 'GET', path: '/', run: ({ req, res }, ctx) => { renewCookie(req, res, ctx); sendPage(req, res, ctx); } },
  // The page's validator alone, for a page left open through a restart to ask whether the daemon
  // it reconnected to would serve a different page (`checkBuild` in the script). node:http sends no
  // body for a HEAD, so this is the GET's headers and nothing else.
  { method: 'HEAD', path: '/', run: ({ req, res }, ctx) => sendPage(req, res, ctx) },
  { method: 'POST', path: '/api/login', run: login },
  // Open on purpose. The browser fetches these while deciding whether the site can be
  // installed, which is before anyone has signed in, and a 401 there is indistinguishable from
  // "not installable". They carry the configured title and a drawing — the title is already in
  // the `<title>` of the equally-open page above, so nothing is disclosed that was not already.
  { method: 'GET', path: '/manifest.webmanifest', run: ({ req, res }, ctx) => sendManifest(req, res, ctx.instance) },
  { method: 'GET', path: '/icon.svg', run: ({ req, res }) => sendIcon(req, res, 'svg') },
  { method: 'GET', path: '/icon.png', run: ({ req, res }) => sendIcon(req, res, 'png') },
  // Open for the reason the manifest is: the browser fetches it again on its own schedule to look
  // for an update, with or without a live session, and it holds nothing but the script in sw.ts.
  { method: 'GET', path: '/sw.js', run: ({ req, res }) => sendServiceWorker(req, res) },
  // The page's own script and stylesheet. Open because the page above is a shell without them,
  // and it is served to someone who has not signed in yet — the gate is drawn and submitted by
  // that script. They are the bytes the page used to carry inline, which was already open, so
  // nothing is disclosed that was not. Only those two names (`only`): the code view's bundle
  // under the same prefix is not needed before sign-in, and stays behind the session (GUARDED).
  {
    method: 'GET',
    path: '/assets/',
    prefix: true,
    only: (rest, ctx) => rest === ctx.assets.app || rest === ctx.assets.style,
    run: ({ req, res, rest }, ctx) => asset(req, res, ctx.assets, rest),
  },
];

/** Everything else. */
const GUARDED: Route[] = [
  { method: 'GET', path: '/api/events', run: stream },
  // One topic's state, whole, without attaching to it — what the page fetches ahead of time for
  // the topics that need a person. Read-only; see `WebRoom.snapshot`.
  { method: 'GET', path: '/api/topic', run: topicSnapshot },
  { method: 'POST', path: '/api/send', run: submit },
  { method: 'POST', path: '/api/click', run: click },
  { method: 'POST', path: '/api/topics', run: createTopic },
  { method: 'POST', path: '/api/topics/clear', run: clearTopics },
  { method: 'POST', path: '/api/topics/delete', run: deleteTopic },
  { method: 'POST', path: '/api/topics/star', run: starTopic },
  { method: 'POST', path: '/api/seen', run: seen },
  { method: 'GET', path: '/api/push', run: pushKey },
  { method: 'POST', path: '/api/push/subscribe', run: pushSubscribe },
  { method: 'POST', path: '/api/push/unsubscribe', run: pushUnsubscribe },
  { method: 'POST', path: '/api/topics/close-idle', run: closeIdle },
  { method: 'POST', path: '/api/topics/kill', run: killTopic },
  // The scheduled-task panel: the list, and one action on one task. Behind the same session as
  // everything else; the four verbs are validated in protocol.ts before they reach the daemon.
  { method: 'GET', path: '/api/schedules', run: scheduleList },
  { method: 'POST', path: '/api/schedules/op', run: scheduleOp },
  // A task's page: its detail and runs, and an edit — `schedule edit`, with its rules, from a form.
  { method: 'GET', path: '/api/schedules/task', run: scheduleDetail },
  { method: 'POST', path: '/api/schedules/edit', run: scheduleEdit },
  { method: 'GET', path: '/api/schedules/form', run: scheduleForm },
  { method: 'POST', path: '/api/schedules/add', run: scheduleAdd },
  // The skills page: the gateway's managed skills, and one operation on one of them. Behind the
  // same session as everything else, and the operation is a closed union in protocol.ts — there
  // is no hard delete among the verbs, because the store has none.
  // The status line's model switch: the list for a topic (starting its agent if that is what it
  // takes — the same warm-up /model does), and the switch, which is /model's.
  { method: 'GET', path: '/api/models', run: modelList },
  { method: 'POST', path: '/api/models', run: modelChoose },
  // Beside it, the agent's own settings (an account, say): which ones to draw for a topic with no
  // status yet (`peek=1`, never starting its agent), the choices for one (starting it, as above),
  // and a pick, which the agent may refuse in its own words.
  { method: 'GET', path: '/api/options', run: optionList },
  { method: 'POST', path: '/api/options', run: optionChoose },
  // What one turn changed in its workspace, and one of those files read out of the turn's two
  // snapshots. Both are read-only and both take a topic id, a turn number and (for the file) a
  // path relative to the repository root; the daemon refuses a path that turn did not change.
  { method: 'GET', path: '/api/turn-changes/status', run: turnChangesStatus },
  { method: 'GET', path: '/api/turn-changes/file', run: turnChangesFile },
  { method: 'GET', path: '/api/skills', run: skillsList },
  { method: 'POST', path: '/api/skills/op', run: skillsOp },
  { method: 'GET', path: '/api/reviews', run: reviewsList },
  // Dismissing a preference suggestion — the Reviews tab's only write, to reviews.json alone.
  { method: 'POST', path: '/api/reviews/op', run: reviewsOp },
  // The git window: the change list for one comparison, one file's two sides and patch, the
  // branches a base may name, and the repository's history — one page of commits, one commit and
  // one of its files. Read-only — there is no stage, commit or discard route here, and nothing in
  // `daemon/git-panel.ts` writes to a repository. All take `?t=` and run on the machine the
  // topic's agent runs on.
  { method: 'GET', path: '/api/git/status', run: gitStatusView },
  { method: 'GET', path: '/api/git/file', run: gitFileView },
  { method: 'GET', path: '/api/git/branches', run: gitBranchesView },
  { method: 'GET', path: '/api/git/log', run: gitLogView },
  { method: 'GET', path: '/api/git/commit', run: gitCommitView },
  { method: 'GET', path: '/api/git/commit-file', run: gitCommitFileView },
  // The history page: every conversation in the library, a keyword search over them, and one
  // opened whole. Read-only, and the same store `fleetherd sessions` reads. Every parameter is in
  // the query string rather than a body, so the checks are here — there is no schema to hold them.
  { method: 'GET', path: '/api/history', run: historyList },
  { method: 'GET', path: '/api/history/search', run: historySearch },
  { method: 'GET', path: '/api/history/read', run: historyRead },
  { method: 'DELETE', path: '/api/topics', run: deleteTopic },
  { method: 'POST', path: '/api/logout', run: logout },
  { method: 'GET', path: '/f/', prefix: true, run: ({ req, res, rest }, ctx) => download(req, res, ctx.room, rest) },
  // The same token, rendered for the reader instead of handed over: JSON holding HTML built by
  // `reading.ts`, never the file's own bytes or type. See `view`.
  { method: 'GET', path: '/view/', prefix: true, run: ({ req, res, rest }, ctx) => view(req, res, ctx.room, rest) },
  // Every built asset: the code view's bundle and the language chunks it imports, and the page's
  // own script and stylesheet (also reachable before sign-in, see OPEN). The one route that serves
  // a script off disk — see `asset`, and the security note beside the page's CSP.
  { method: 'GET', path: '/assets/', prefix: true, run: ({ req, res, rest }, ctx) => asset(req, res, ctx.assets, rest) },
  // The terminal pane's backend. Listed unconditionally even though the feature is usually
  // off, so this table stays the complete answer to "what is reachable"; `terminalPage`
  // answers 404 when it is off, which is the truth about the route either way.
  { method: 'GET', path: '/term/', prefix: true, run: terminalPage },
  // Ending a session, as opposed to closing a pane. Guarded like everything else, and refused
  // outright when the operator configured no way to do it — see `terminal-sessions.ts`.
  { method: 'POST', path: '/api/terminal/end', run: endTerminal },
  // ── The file window (platforms.<id>.files) ────────────────────────────────
  // Listed as a group, and like the terminal's routes they answer 404 when the feature is off
  // (`filesOn`) — the table stays the complete list of what exists, the answer says whether this
  // deployment has it. Reads are GET with every parameter in the query string; writes are POST
  // with a `.strict()` body in protocol.ts.
  { method: 'GET', path: '/api/files/list', run: filesList },
  { method: 'GET', path: '/api/files/read', run: filesRead },
  { method: 'GET', path: '/api/files/search', run: filesSearch },
  { method: 'POST', path: '/api/files/write', run: filesWrite },
  { method: 'POST', path: '/api/files/create', run: filesCreate },
  { method: 'POST', path: '/api/files/rename', run: filesRename },
  { method: 'POST', path: '/api/files/remove', run: filesRemove },
  // ── The instruction editor (platforms.<id>.instructions) ─────────────────
  // The settings page's list of instruction files, one agent's referenced files, and a read and a
  // write of one of them. 404 while the feature is off, like the file window. No route takes a free
  // path: a global file is a name, an agent's file is checked against what its harness references.
  { method: 'GET', path: '/api/instructions', run: instructionsList },
  { method: 'GET', path: '/api/instructions/refs', run: instructionsRefs },
  { method: 'GET', path: '/api/instructions/read', run: instructionsRead },
  { method: 'POST', path: '/api/instructions/write', run: instructionsWrite },
];

/**
 * A table rather than a chain of ifs, for two reasons beyond the complexity limit: the two
 * lists ARE the answer to "what can be reached without signing in", which is worth being able
 * to read at a glance; and a route added to the wrong list is then a visible mistake rather
 * than a missing `if`.
 */
function match(routes: readonly Route[], method: string, path: string, ctx: Ctx): { route: Route; rest: string } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.prefix) {
      if (!path.startsWith(route.path)) continue;
      const rest = path.slice(route.path.length);
      if (!route.only || route.only(rest, ctx)) return { route, rest };
    } else if (path === route.path) {
      return { route, rest: '' };
    }
  }
  return undefined;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';

  const open = match(OPEN, method, url.pathname, ctx);
  if (open) return open.route.run({ req, res, url, rest: open.rest }, ctx);

  // One gate for everything else, rather than a check inside each handler, so a route added
  // later is protected by default instead of by remembering.
  if (!(await admitted(req, ctx))) return send(req, res, 401, { error: 'not signed in' });
  if ((method === 'POST' || method === 'DELETE') && !sameOrigin(req)) return send(req, res, 403, { error: 'cross-origin request refused' });

  const guarded = match(GUARDED, method, url.pathname, ctx);
  if (guarded) return guarded.route.run({ req, res, url, rest: guarded.rest }, ctx);
  send(req, res, 404, { error: 'no such route' });
}

/**
 * Either door: a session cookie this server minted, or an assertion from the proxy in front.
 *
 * The cookie is tried first because it costs a map lookup while the other may cost a key
 * fetch — not because it is the stronger of the two. Under SSO there is usually no cookie at
 * all: nobody signed in here, the proxy did it, and every request carries the proof.
 */
async function admitted(req: IncomingMessage, ctx: Ctx): Promise<boolean> {
  if (ctx.auth.check(req.headers.cookie)) return true;
  if (!ctx.sso) return false;
  const result = await ctx.sso.identify(req);
  if (!result.ok) noteRefusal(req, ctx, result.reason);
  return result.ok;
}

/**
 * Say why someone was turned away, at most once a minute per reason and source.
 *
 * Unthrottled this would be a line every few seconds: `EventSource` reconnects on its own, so
 * one misconfigured browser is a permanent stream of identical refusals — and a log that
 * scrolls is a log nobody reads the real line in. The source address is included deliberately:
 * a `source` refusal means `sso.from` does not list the proxy, and this line is where the
 * operator finds what to put there.
 */
function noteRefusal(req: IncomingMessage, ctx: Ctx, reason: SsoRefusal): void {
  const from = req.socket.remoteAddress ?? 'unknown';
  const key = `${reason}:${from}`;
  const now = Date.now();
  const last = ctx.warned.get(key) ?? 0;
  if (now - last < REFUSAL_QUIET_MS) return;
  if (ctx.warned.size >= MAX_WARN_KEYS) ctx.warned.clear();
  ctx.warned.set(key, now);
  console.warn(`[webui] "${ctx.instance.id}": sso refused a request from ${from} (${reason})`);
}

function logout({ req, res }: Req, ctx: Ctx): void {
  ctx.auth.revoke(req.headers.cookie);
  send(req, res, 200, { ok: true });
}

/**
 * Re-issue a still-valid session cookie with a fresh `Max-Age`.
 *
 * The server slides a session's expiry on every use, but the browser drops the cookie at the
 * `Max-Age` it was given at login — so without this, a tab used daily still hit the password
 * gate exactly a week after signing in. Done on the page load only: it is the one request every
 * visit makes, and a `Set-Cookie` on each API call would be the same effect many times over.
 */
function renewCookie(req: IncomingMessage, res: ServerResponse, ctx: Ctx): void {
  const id = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (id && ctx.auth.check(req.headers.cookie)) res.setHeader('Set-Cookie', sessionCookie(id, isSecure(req)));
}

/**
 * The page, or a 304 when the browser already holds this exact one.
 *
 * `private, no-cache` rather than the `no-store` it had: the reason given for that — a stale copy
 * after an upgrade is a support question — rules out a cache that is used WITHOUT asking, not one
 * that asks. `no-cache` asks every time, and the ETag is a hash of the rendered bytes, so the first
 * load after an upgrade gets the new page as surely as before; every other load costs one round
 * trip instead of 134 KB. `private` because the response can carry a renewed session cookie
 * (`renewCookie`), which no shared cache may keep.
 *
 * No service worker stands in the way: `sw.ts` has no fetch handler, so this header is the whole of
 * the page's caching.
 */
function sendPage(req: IncomingMessage, res: ServerResponse, ctx: Ctx): void {
  const page = servedPage(ctx);
  const headers: Record<string, string> = {
    ...PAGE_HEADERS,
    'Cache-Control': 'private, no-cache',
    ETag: page.etag,
    // On every answer, compressed or not and 304 or not: which body a cache holds depends on it.
    Vary: 'Accept-Encoding',
  };
  if (matchesEtag(req, page.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const takesBr = accepts(req, 'br');
  if (takesBr) brotliPage(page);
  const br = takesBr ? page.br : undefined;
  const gzip = !br && acceptsGzip(req);
  const out = br ?? (gzip ? page.gzip : page.raw);
  res.writeHead(200, {
    ...headers,
    'Content-Length': String(out.length),
    ...(br ? { 'Content-Encoding': 'br' } : gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(out);
}

/** The built files the page links, as page-relative URLs (see `PageAssets`). */
function pageAssets(assets: WebAssets): PageAssets {
  const at = (name: string | null): string | null => (name === null ? null : `assets/${name}`);
  return { app: at(assets.app), style: at(assets.style), codeview: at(assets.codeview) };
}

/** Render, hash and compress the page — once per set of render inputs. */
function servedPage(ctx: Ctx): ServedPage {
  const args = [
    ctx.instance.title,
    ctx.terminal.enabled,
    passwordLogin(ctx.instance),
    ctx.terminal.sessions.canEnd,
    // Relative, like every other URL on the page: a gateway mounted under a sub-path serves the
    // assets from `<prefix>/assets/` and the page's own references resolve the same way.
    pageAssets(ctx.assets),
    filesOn(ctx),
    instructionsOn(ctx),
  ] as const;
  const key = JSON.stringify(args);
  if (ctx.page?.key === key) return ctx.page;
  const { html, build } = servePage(...args);
  const raw = Buffer.from(html, 'utf8');
  const page: ServedPage = { key, raw, gzip: gzipSync(raw), etag: `W/"${build}"` };
  ctx.page = page;
  return page;
}

/**
 * Make the page's brotli form, the first time a client that takes br asks for the page. Off the
 * event loop (zlib's async form runs on libuv's pool), and onto this entry only: a page rendered
 * again meanwhile is a different entry and makes its own. Nothing is made for a deployment whose
 * clients never ask — a proxy that only takes gzip, say.
 */
function brotliPage(page: ServedPage): void {
  if (page.br || page.brotli) return;
  page.brotli = true;
  brotliCompress(
    page.raw,
    {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: page.raw.length,
      },
    },
    (e, out) => {
      if (e) console.warn(`[webui] could not brotli the page, serving gzip: ${e.message}`);
      else page.br = out;
    }
  );
}

/** Whether `If-None-Match` names this validator. Compared weakly, as RFC 9110 §13.1.2 says for it. */
function matchesEtag(req: IncomingMessage, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  const mine = opaque(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === mine);
}

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  // Belt and braces around web-markdown's escaping: even if something did get through, an
  // inline script from it would not run and no external origin could be reached.
  //
  // `frame-src 'self'` is what lets the terminal pane exist. Same-origin is not a sandbox —
  // ttyd's page can read this one's DOM and its cookie — and that is accepted knowingly:
  // the alternative buys nothing, because a cross-origin iframe would need
  // `allow-same-origin` to hold a session at all and that undoes the sandbox. The trade is
  // ttyd's terminal, with its IME and file transfer, against re-implementing all of it here.
  //
  // `worker-src 'self'` is what lets the page register sw.js (webpush.ts says why there is one).
  // It names where a WORKER may be loaded from and nothing else.
  //
  // `script-src 'self'`, and nothing else: since Phase 1 Step 1A (docs/refactor-plan.md) the page
  // has no inline script left — its own script and the code view are both files `/assets/` serves
  // (see `asset`), and what the server decides per deployment travels as a JSON `boot-config`
  // element, which no browser executes. So an inline script that got past web-markdown's escaping
  // would not run at all, where before only an external one was refused. The only other
  // JavaScript response a handler here produces is sw.js. `/term/` is not this file's to
  // promise — `proxyRequest` copies the upstream's headers verbatim, so its Content-Type is
  // ttyd's, whatever ttyd decides to serve (server.test.ts pins a fake upstream answering as
  // JavaScript). What is left is the
  // hole an agent's file could climb through, and it is not one: a download is `attachment` with
  // `nosniff`, and its type is `application/octet-stream` unless it is one of the closed set of
  // raster images `inlineImageType` admits — so no bytes the agent wrote are ever parsed as a
  // script on this origin, and the reader shows an `.html` as source rather than a document. The
  // route is behind the session like everything else, and `server.test.ts` pins that no other
  // handler here carries a JavaScript content type.
  //
  // `style-src 'self'` is the page's stylesheet, from the same route. `'unsafe-inline'` stays
  // beside it: the script sets `style` attributes throughout (widths, positions, the drawer), and
  // the code view's CodeMirror injects its theme as `<style>` elements.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; manifest-src 'self'; worker-src 'self'; form-action 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * The manifest, which is what makes "add to home screen" offer an app rather than a bookmark.
 *
 * `no-store`, unlike the page's validated cache: the name and the colours come from config, an
 * installed app holding last week's title is a support question with no error message, and at a
 * few hundred bytes the manifest is not worth a validator.
 * The icons below are the opposite case — bytes that only change when this file does — so they
 * get a long cache and save the round trip on every launch.
 */
function sendManifest(req: IncomingMessage, res: ServerResponse, instance: WebuiInstance): void {
  body(req, res, 200, Buffer.from(renderManifest(instance.title), 'utf8'), {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

function sendIcon(req: IncomingMessage, res: ServerResponse, kind: 'svg' | 'png'): void {
  const [payload, type] =
    kind === 'svg'
      ? [Buffer.from(ICON_SVG, 'utf8'), 'image/svg+xml']
      : [ICON_PNG, 'image/png'];
  body(req, res, 200, payload, {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=604800',
    // An SVG fetched as a document can script; served with nosniff and only ever referenced as
    // an image it cannot, but the header costs nothing and the reasoning should not have to be
    // re-derived by whoever adds the next asset route.
    'X-Content-Type-Options': 'nosniff',
  });
}

async function login({ req, res }: Req, ctx: Ctx): Promise<void> {
  // Configured shut. Answered explicitly rather than by letting every attempt fail as a wrong
  // password: an operator who turned this off and then cannot get in deserves to be told which
  // of the two doors they are knocking on.
  if (!passwordLogin(ctx.instance)) return send(req, res, 403, { error: 'password login is disabled' });
  const parsed = await readBody(req, res, LoginRequestSchema);
  if (!parsed) return;
  // The socket address, only ever as a throttling key — never logged, never authorization.
  const result = ctx.auth.login(parsed.token, req.socket.remoteAddress ?? 'unknown');
  if (!result.ok) {
    const status = result.reason === 'throttled' ? 429 : 401;
    if (result.reason === 'throttled') res.setHeader('Retry-After', String(result.retryAfterSec));
    console.warn(`[webui] "${ctx.instance.id}": login refused (${result.reason})`);
    return send(req, res, status, { error: result.reason });
  }
  res.setHeader('Set-Cookie', sessionCookie(result.sessionId, isSecure(req)));
  send(req, res, 200, { ok: true });
}

/**
 * Attach an event stream to one topic.
 *
 * Per topic, not per connection to the whole UI: a client reading one room should not be
 * billed for traffic in another, which on a weak link is the difference between usable and
 * not. The topic LIST still reaches every client (see `WebRoom.announceTopics`), so the
 * switcher stays current without subscribing to rooms nobody is reading.
 */
function stream({ req, res, url }: Req, ctx: Ctx): void {
  const wanted = url.searchParams.get('t');
  const topic = wanted && ctx.room.topics.has(wanted) ? wanted : ctx.room.topics.current().id;
  const out = openStream(req, res, ctx.instance);
  ctx.streams.add(out);
  // The header is what `EventSource` sends when it reconnects by itself, and it is always the newer
  // of the two. `?last=` is the page's own way to resume a stream it closed on purpose (a tab put in
  // the background, see the page's `park`): a new EventSource cannot set a header, and without a
  // resume point it would be handed the whole topic again. The room validates either the same way.
  const header = req.headers['last-event-id'];
  const lastId = (Array.isArray(header) ? header[0] : header) || url.searchParams.get('last') || undefined;
  // The version of the topic list the page holds, so a resume carries the list only if it moved.
  const tv = Number(url.searchParams.get('tv') ?? NaN);
  const unsubscribe = ctx.room.subscribe(
    topic,
    // `data` is made once per event by the room, however many streams it goes to.
    (id, _ev, data) => out.write(`${id ? `id: ${id}\n` : ''}data: ${data}\n\n`),
    lastId,
    Number.isInteger(tv) ? tv : undefined
  );
  // The response's close, not only the request's: a stream cut for falling behind is ended from
  // this side, and either way it has to leave the room's fan-out at once.
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    unsubscribe();
    ctx.streams.delete(out);
  };
  req.on('close', leave);
  res.on('close', leave);
}

/**
 * One topic, whole, without attaching to it.
 *
 * The page fetches this for the topics that need a person, so tapping one paints at once instead
 * of waiting for a sync: on a long topic that sync is up to 1000 messages and 1.5 MB of JSON.
 * Read-only — nothing here subscribes, announces the list, logs, or marks anything seen; see
 * `WebRoom.snapshot`.
 *
 * The id is checked the way the history routes check theirs: the query string has no schema, so
 * the shape is checked here before it reaches the room.
 */
async function topicSnapshot({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const id = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(id)) return send(req, res, 400, { error: 'not a topic id' });
  const snapshot = ctx.room.snapshot(id);
  if (!snapshot) return send(req, res, 404, { error: 'no such topic' });
  await sendAsyncGzip(req, res, 200, snapshot);
}

/** Open the response as an event stream, compressed when the client will take it. */
function openStream(req: IncomingMessage, res: ServerResponse, instance: WebuiInstance): Stream {
  const gzip = acceptsGzip(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // `no-transform` and `X-Accel-Buffering` both say the same thing to different proxies: do
    // not buffer this. nginx buffers SSE by default, and a buffered stream shows nothing at all
    // until the turn ends — which reads exactly like a hung daemon.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.flushHeaders();
  const gz = gzip ? createGzip() : undefined;
  gz?.pipe(res);
  // Everything this process is holding for the client: the compressor's input and output, then the
  // response's own buffer and its socket's (`writableLength` on a response counts both).
  const behind = (): number => (gz ? gz.writableLength + gz.readableLength : 0) + res.writableLength;
  let since = 0;
  let cut = false;
  /** Whether the stream has stayed over `MAX_BEHIND_BYTES` for `MAX_BEHIND_MS`; cuts it if so. */
  const fallenBehind = (): boolean => {
    const bytes = behind();
    if (bytes <= MAX_BEHIND_BYTES) {
      since = 0;
      return false;
    }
    const now = Date.now();
    if (since === 0) since = now;
    if (now - since < MAX_BEHIND_MS) return false;
    cut = true;
    console.warn(
      `[webui] "${instance.id}": cutting an event stream ${(bytes / 1048576).toFixed(1)} MB behind for ` +
        `${Math.round((now - since) / 1000)}s; the page reconnects and resumes from its last event`
    );
    // Destroyed rather than ended: an end would queue behind everything the client is not reading.
    gz?.destroy();
    res.destroy();
    return true;
  };
  return {
    // Checked before each write, against what earlier writes left behind. The event that finds the
    // stream cut is not lost with it: it is in the topic's backlog, which the reconnect replays. A
    // quiet stream is still checked, by the heartbeat.
    write: (chunk) => {
      if (cut || fallenBehind()) return;
      if (!gz) {
        res.write(chunk);
        return;
      }
      // Z_SYNC_FLUSH after EVERY event, and this is the whole trap of compressing a stream: a
      // gzip stream buffers until told otherwise, so without it the browser receives nothing
      // until the connection closes — a live UI that shows the entire turn at the end of it.
      gz.write(chunk);
      gz.flush(zlibConstants.Z_SYNC_FLUSH);
    },
    end: () => {
      if (!cut) (gz ?? res).end();
    },
  };
}

/**
 * A message from the page: JSON, or — when it carries files — the same request framed as bytes.
 *
 * The files used to travel only as base64 inside the JSON, a third larger than they are: on a
 * 250 kbps uplink a 1 MB photo took 44 s instead of 33. A send with files now comes as
 * `application/octet-stream` (`readFramedSend`), and is turned back into the JSON request's shape
 * — base64 and all, which is what `room.submit` and the daemon's `data:` URL path take — and then
 * validated by the very same schema, so every limit and check is the JSON request's. Same route,
 * same nonce: a retry of either form is the same message.
 */
async function submit({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = isOctetStream(req) ? await readFramedSend(req, res) : await readBody(req, res, SendRequestSchema, true);
  if (!parsed) return;
  switch (ctx.room.submit(parsed)) {
    case 'unknown-topic':
      return send(req, res, 404, { error: 'no such topic' });
    // A retry of something already accepted, which is the point of the nonce — answer as if
    // this were the original, because for the caller it is.
    case 'duplicate':
    case 'accepted':
      return send(req, res, 202, { ok: true });
  }
}

async function click({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ClickRequestSchema);
  if (!parsed) return;
  // An id the room does not hold is a stale tab or a hand-made request; either way the daemon's
  // click handlers would go on to EDIT whatever it names, so it stops here.
  if (!ctx.room.click(parsed)) return send(req, res, 409, { error: 'that message is gone' });
  send(req, res, 202, { ok: true });
}

async function createTopic({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, CreateTopicRequestSchema);
  if (!parsed) return;
  try {
    send(req, res, 201, { topic: ctx.room.createTopic(parsed.title ?? '') });
  } catch (e) {
    // The room evicts the oldest topic to make room, so reaching this means every topic is starred
    // or in use. The message says which and what to do; the page shows it. Logged as well, since a
    // refusal used to leave no trace anywhere but the browser's network panel.
    const error = e instanceof Error ? e.message : 'could not create a topic';
    console.warn(`[webui] refused to open a topic: ${error}`);
    send(req, res, 409, { error });
  }
}

async function starTopic({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, StarTopicRequestSchema);
  if (!parsed) return;
  if (!ctx.room.starTopic(parsed.topic, parsed.starred)) return send(req, res, 404, { error: 'no such topic' });
  send(req, res, 200, { ok: true });
}

async function deleteTopic({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, DeleteTopicRequestSchema);
  if (!parsed) return;
  if (!ctx.room.deleteTopic(parsed.topic)) {
    return send(req, res, 404, { error: 'no such topic' });
  }
  send(req, res, 200, { ok: true });
}

/**
 * The service worker. `no-cache`, so the browser asks again on every check — an old worker keeping
 * an old notification handler alive across an upgrade is the kind of stale copy this page avoids —
 * and a CSP of its own, which is the one a worker runs under: no network at all except this
 * origin's icon, and this origin's own routes, for the topic a push is about (`api/topic`, sw.ts
 * keepTopic). Same-origin is the whole of it: a redirect elsewhere — an expired access session's
 * sign-in page — is refused rather than followed.
 */
function sendServiceWorker(req: IncomingMessage, res: ServerResponse): void {
  body(req, res, 200, Buffer.from(SERVICE_WORKER, 'utf8'), {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; connect-src 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
}

/** Whether this server sends push notifications, and the key a browser subscribes with. */
function pushKey({ req, res }: Req, ctx: Ctx): void {
  if (!ctx.push) return send(req, res, 200, { enabled: false });
  send(req, res, 200, { enabled: true, key: ctx.push.publicKey });
}

async function pushSubscribe({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, PushSubscribeSchema);
  if (!parsed) return;
  if (!ctx.push) return send(req, res, 404, { error: 'this server sends no notifications' });
  try {
    ctx.push.subscribe({ endpoint: parsed.endpoint, keys: parsed.keys });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'refused';
    console.warn(`[webui] refused a push subscription: ${error}`);
    return send(req, res, 400, { error });
  }
  console.log(`[webui] "${ctx.instance.id}": a device subscribed to notifications (${ctx.push.count} now)`);
  send(req, res, 200, { ok: true });
}

async function pushUnsubscribe({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, PushUnsubscribeSchema);
  if (!parsed) return;
  ctx.push?.unsubscribe(parsed.endpoint);
  send(req, res, 200, { ok: true });
}

/** The page is showing a topic to someone (see WebRoom.markSeen). A topic that is gone is not an error. */
async function seen({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, SeenRequestSchema);
  if (!parsed) return;
  ctx.room.markSeen(parsed.topic);
  send(req, res, 200, { ok: true });
}

/**
 * Forget every unstarred topic and answer with the fresh one that replaced them, plus the list as
 * it now stands.
 *
 * Both come back in the response rather than being left for the broadcast `topics` event to
 * reveal: the page has to drop its own per-topic caches and then land somewhere, and racing a
 * POST against an SSE frame to find out where is a worse contract than being told. The list is
 * what tells it which caches to KEEP — the starred topics survive the sweep, and their
 * transcripts, drafts and terminal windows have to survive it on the page too.
 */
async function clearTopics({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ClearTopicsRequestSchema);
  if (!parsed) return;
  const topic = ctx.room.clearTopics();
  send(req, res, 200, { topic, topics: ctx.room.topicList() });
}

/**
 * End the agent process behind each listed topic that is still idle, and answer which were ended
 * and which were left running. See `WebRoom.closeIdle` for what "still idle" is checked against.
 */
async function closeIdle({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, CloseIdleRequestSchema);
  if (!parsed) return;
  send(req, res, 200, ctx.room.closeIdle(parsed.topics));
}

/**
 * End the agent processes behind the topics the person confirmed, among the subtree of `topic`,
 * answering what became of each. The walk is the daemon's (`WebRoom.killTopic` →
 * `Delegation.endTopic`); the page sends the list the dialog showed, and a sub-agent opened after
 * that is not ended because it is not in it.
 */
async function killTopic({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, KillTopicRequestSchema);
  if (!parsed) return;
  send(req, res, 200, ctx.room.killTopic(parsed.topic, parsed.topics));
}

/**
 * Every scheduled task, for the page's side panel. `enabled: false` when this daemon was started
 * without a schedule store (tests, mostly), so the panel can say so instead of pretending the
 * gateway has no tasks.
 */
function scheduleList({ req, res }: Req, ctx: Ctx): void {
  send(req, res, 200, ctx.room.schedules());
}

/**
 * One action on one task. A refusal is the service's own sentence — "already paused", "no such
 * scheduled task", "running right now" — handed back as-is so the panel can show it without a
 * second copy of the rules. `announce: false` is the room's side (see `WebRoom.scheduleOp`): the
 * panel is the acknowledgement, and posting a card into a conversation would say it twice.
 */
async function scheduleOp({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ScheduleOpRequestSchema);
  if (!parsed) return;
  const result = ctx.room.scheduleOp(parsed.id, parsed.action, 'tags' in parsed ? parsed.tags : undefined);
  send(req, res, result.ok ? 200 : 400, result);
}

/** One task's page, by `?id=`. 404 when there is no such task: the page closes and says so. */
function scheduleDetail({ req, res, url }: Req, ctx: Ctx): void {
  const id = ScheduleTaskId.safeParse(url.searchParams.get('id') ?? '');
  if (!id.success) return send(req, res, 400, { ok: false, error: 'not a task id' });
  const result = ctx.room.scheduleDetail(id.data);
  send(req, res, result.ok ? 200 : 404, result);
}

/**
 * Change a task from its page. A refusal is the service's own sentence, as for `scheduleOp`, and
 * the answer carries the page and the list as they now are.
 */
async function scheduleEdit({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ScheduleEditRequestSchema);
  if (!parsed) return;
  const result = await ctx.room.scheduleEdit(parsed.id, parsed.edit);
  send(req, res, result.ok ? 200 : 400, result);
}

/** What the new-task form offers. 404 when the daemon has no scheduled tasks, as a detail would be. */
function scheduleForm({ req, res }: Req, ctx: Ctx): void {
  const result = ctx.room.scheduleForm();
  send(req, res, result.ok ? 200 : 404, result);
}

/**
 * Register a task from the panel's form. A refusal is the service's own sentence — `schedule add`'s
 * words — and the answer carries the new task's page and the list, as an edit's does.
 */
async function scheduleAdd({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ScheduleAddRequestSchema);
  if (!parsed) return;
  const result = await ctx.room.scheduleAdd(parsed.task);
  send(req, res, result.ok ? 200 : 400, result);
}

/**
 * What the topic named by `?t=` can switch its model to. Slow the first time (a cold agent is
 * started, as `/model` would start it), so the page shows that it is asking. 200 either way: "no
 * list" is an answer with a sentence, not a failure of the request.
 */
async function modelList({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{8}$/.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  send(req, res, 200, await ctx.room.models(topic));
}

/** Switch a topic's model. A refusal is `/model`'s own sentence, handed back to be shown. */
async function modelChoose({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ModelChooseRequestSchema);
  if (!parsed) return;
  const result = await ctx.room.chooseModel(parsed.topic, parsed.value);
  send(req, res, result.ok ? 200 : 409, result);
}

/**
 * The agent's own settings for the topic named by `?t=`. With `peek=1`, only which to draw and what
 * is known of them, without starting the agent; otherwise their choices, starting a cold agent the
 * way the model list does. 200 either way, as for the model list.
 */
async function optionList({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!/^[0-9a-f]{8}$/.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  send(req, res, 200, url.searchParams.get('peek') === '1' ? await ctx.room.optionStatus(topic) : await ctx.room.options(topic));
}

/** Set one of a topic's settings. A refusal is the agent's (or the daemon's) sentence, handed back to be shown. */
async function optionChoose({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, OptionChooseRequestSchema);
  if (!parsed) return;
  const result = await ctx.room.chooseOption(parsed.topic, parsed.id, parsed.value);
  send(req, res, result.ok ? 200 : 409, result);
}

/**
 * The two parameters every turn-changes route needs: which topic, and which turn.
 *
 * The topic id is the same hex shape protocol.ts enforces on the way in, and the turn number is
 * the daemon's own — a positive integer, bounded so a nonsense number never reaches a lookup.
 * Anything else is a 400: these are GETs, so there is no schema to hold the check.
 */
function turnChangeQuery(url: URL): { topic: string; turn: number } | undefined {
  const topic = url.searchParams.get('t') ?? '';
  const turn = Number(url.searchParams.get('turn') ?? '');
  if (!/^[0-9a-f]{8}$/.test(topic)) return undefined;
  if (!Number.isInteger(turn) || turn < 1 || turn > 1_000_000) return undefined;
  return { topic, turn };
}

/** One turn's changed files — the answer the git window's status tab reads. */
async function turnChangesStatus({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const q = turnChangeQuery(url);
  if (!q) return send(req, res, 400, { error: 'a topic id and a turn number are required' });
  // A well-formed question with no record answers with the failure shape, 200: the window shows
  // the daemon's own sentence rather than a protocol error.
  send(req, res, 200, await ctx.room.turnChangesStatus(q.topic, q.turn));
}

/** One changed file of one turn: both sides whole, and its unified diff. */
async function turnChangesFile({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const q = turnChangeQuery(url);
  const p = url.searchParams.get('path') ?? '';
  if (!q || !p) return send(req, res, 400, { error: 'a topic id, a turn number and a path are required' });
  // A path is only ever a repository-relative name; this bound is about absurd input, and the
  // daemon's own check — was it changed in this turn — is what actually decides.
  if (p.length > 4096) return send(req, res, 400, { error: 'that path is too long' });
  const answer = await ctx.room.turnChangesFile(q.topic, q.turn, p);
  send(req, res, answer.ok ? 200 : 404, answer);
}

/**
 * Every managed skill, for the page's skills window. `enabled: false` when this daemon was
 * started without the panel (tests, mostly), so the page can say so instead of pretending the
 * gateway has no skills.
 */
function skillsList({ req, res }: Req, ctx: Ctx): void {
  send(req, res, 200, ctx.room.skills());
}

/**
 * One operation on one skill. A refusal is the store's own sentence — "version mismatch", "no
 * skill named …", "files may only go in …" — handed back as-is, so the page never restates a rule
 * it does not own. A successful write answers with the fresh list, and `show` with the detail,
 * because racing a refresh against the page's own write is the one moment it could show the old
 * state as the new one.
 */
async function skillsOp({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, SkillOpRequestSchema);
  if (!parsed) return;
  const result = await ctx.room.skillOp(parsed);
  send(req, res, result.ok ? 200 : 400, result);
}

/**
 * Every recorded automatic review, for the panel's Reviews tab, with the preference suggestions
 * still pending.
 *
 * A review is written by the sweep through the skill store's own rules, and the only way to undo
 * one is the `fleetherd skills revert` / `archive` command the row names. Nothing the page posts
 * changes a review or a skill — see `useReviewPanel`.
 */
function reviewsList({ req, res }: Req, ctx: Ctx): void {
  send(req, res, 200, ctx.room.reviews());
}

/** Dismiss one pending preference suggestion, answering with the fresh list. */
async function reviewsOp({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ReviewOpRequestSchema);
  if (!parsed) return;
  const result = ctx.room.reviewOp(parsed);
  send(req, res, result.ok ? 200 : 400, result.ok ? result.list : { error: result.error });
}

/**
 * The git window's change list. 200 even for "not a git repository" and for a comparison git
 * could not make: those are answers with a sentence, like the model list's "no models", not a
 * failure of the request. Only a malformed query is a 400.
 */
async function gitStatusView({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  const base = url.searchParams.get('base');
  const parsed = parseBody(GitStatusQuerySchema, {
    mode: url.searchParams.get('mode') ?? '',
    ...(base ? { base } : {}),
  });
  if (!parsed.ok) return send(req, res, 400, { error: parsed.error });
  send(req, res, 200, await ctx.room.gitStatus(topic, parsed.value.mode, parsed.value.base));
}

/** One file's two sides and patch, for the diff. The path is checked again in git-panel.ts. */
async function gitFileView({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  const base = url.searchParams.get('base');
  const parsed = parseBody(GitFileQuerySchema, {
    mode: url.searchParams.get('mode') ?? '',
    ...(base ? { base } : {}),
    path: url.searchParams.get('path') ?? '',
  });
  if (!parsed.ok) return send(req, res, 400, { error: parsed.error });
  send(req, res, 200, await ctx.room.gitFile(topic, parsed.value.mode, parsed.value.base, parsed.value.path));
}

/** The branches a base may name, for the git window's picker. */
async function gitBranchesView({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  send(req, res, 200, await ctx.room.gitBranches(topic));
}

/** One page of the history, newest first. A page past the end is an empty page, not an error. */
async function gitLogView({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  const parsed = parseBody(GitLogQuerySchema, { skip: url.searchParams.get('skip') ?? '0' });
  if (!parsed.ok) return send(req, res, 400, { error: parsed.error });
  send(req, res, 200, await ctx.room.gitLog(topic, parsed.value.skip));
}

/** One commit and the files it changed. The sha is resolved and the list checked in git-panel.ts. */
async function gitCommitView({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  const parsed = parseBody(GitCommitQuerySchema, { sha: url.searchParams.get('sha') ?? '' });
  if (!parsed.ok) return send(req, res, 400, { error: parsed.error });
  send(req, res, 200, await ctx.room.gitCommit(topic, parsed.value.sha));
}

/** One file of one commit, from its parent's version to the commit's. */
async function gitCommitFileView({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const topic = url.searchParams.get('t') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  const parsed = parseBody(GitCommitFileQuerySchema, {
    sha: url.searchParams.get('sha') ?? '',
    path: url.searchParams.get('path') ?? '',
  });
  if (!parsed.ok) return send(req, res, 400, { error: parsed.error });
  send(req, res, 200, await ctx.room.gitCommitFile(topic, parsed.value.sha, parsed.value.path));
}

/** How many conversations one page may carry. The store's own ceiling; a page asks for 50. */
const HISTORY_PAGE_MAX = 200;

/**
 * One page of the conversation library, newest first.
 *
 * `before` is the `next` of the page before it, and is validated by shape rather than trusted: it
 * goes straight into the store's keyset comparison, and a cursor that means nothing would answer
 * with a page that silently repeats or skips rows. `limit` is bounded for the same reason the
 * store bounds it — a page is a screenful, not the library.
 */
function historyList({ req, res, url }: Req, ctx: Ctx): void {
  const before = url.searchParams.get('before') ?? '';
  if (before && !/^\d{1,15}\.\d{1,15}$/.test(before)) return send(req, res, 400, { error: 'not a page of this history' });
  const raw = url.searchParams.get('limit') ?? '';
  const limit = Number(raw);
  if (raw && (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX)) {
    return send(req, res, 400, { error: `limit must be 1..${HISTORY_PAGE_MAX}` });
  }
  send(req, res, 200, ctx.room.historyPage({ ...(before ? { before } : {}), ...(raw ? { limit } : {}) }));
}

/**
 * Keyword matches across the whole library. A query the tokenizer finds no word in is a refusal
 * with the store's own sentence, not an empty answer that reads as "nothing matched".
 */
function historySearch({ req, res, url }: Req, ctx: Ctx): void {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return send(req, res, 400, { error: 'a search needs a word to look for' });
  if (q.length > 200) return send(req, res, 400, { error: 'that search is too long' });
  try {
    send(req, res, 200, ctx.room.historySearch(q));
  } catch (e) {
    send(req, res, 400, { error: e instanceof Error ? e.message : 'could not search the library' });
  }
}

/** One conversation, whole. 404 for an id that names none, with the store's own sentence. */
function historyRead({ req, res, url }: Req, ctx: Ctx): void {
  const raw = url.searchParams.get('id') ?? '';
  if (!/^\d{1,15}$/.test(raw)) return send(req, res, 400, { error: 'not a conversation id' });
  try {
    send(req, res, 200, ctx.room.historyRead(Number(raw)));
  } catch (e) {
    send(req, res, 404, { error: e instanceof Error ? e.message : 'no such conversation' });
  }
}

async function download(req: IncomingMessage, res: ServerResponse, room: WebRoom, token: string): Promise<void> {
  const entry = room.resolveDownload(decodeURIComponent(token));
  if (!entry) return send(req, res, 404, { error: 'no such file' });
  // An operator's own picture is published the moment it is sent and written alongside; the page
  // asks for it as soon as the echo lands, which can be before the write has finished.
  if (entry.ready) await entry.ready;
  const size = await stat(entry.path).then(
    (s) => s.size,
    () => undefined
  );
  if (size === undefined) return send(req, res, 404, { error: 'that file is no longer on disk' });
  // Never the file's own type, and always an attachment: an agent that sent an .html or .svg
  // would otherwise get it rendered on this origin, holding this session's cookie.
  //
  // The one exception is a raster image, which the page shows inline and therefore has to be
  // served as itself. `inlineImageType` is the closed list and carries the argument for why
  // that is safe; the rule it does not bend is `nosniff`, which is what stops a document being
  // sniffed out of a file merely NAMED .png.
  const image = inlineImageType(entry.name);
  res.writeHead(200, {
    'Content-Type': image ?? 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': disposition(entry.name, image !== undefined),
    'X-Content-Type-Options': 'nosniff',
    // Belt and braces for the inline case: even a browser that ignored the two headers above
    // and decided to treat this as a document would find a sandbox with no scripts and an
    // opaque origin, which is nobody's session.
    ...(image ? { 'Content-Security-Policy': "default-src 'none'; sandbox" } : {}),
  });
  createReadStream(entry.path).pipe(res);
}

/** A `Content-Disposition` a filename cannot break out of, in both the ASCII and UTF-8 forms. */
function disposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\w.\- ]/g, '_') || 'download';
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * A published file, rendered for the page's reader: `{ name, size, shown, html }`.
 *
 * JSON through `send()`, like any API answer, rather than a document of its own. That is the whole
 * of why this is safe beside `download`'s rule: the browser is handed HTML that `reading.ts` built
 * from the bytes — escaped, as every message is — and puts it into the page it already trusts with
 * those. Nothing here is ever served as the file's own type, so an `.html` arrives as its source.
 *
 * 415 for a name `readableKind` does not accept, and for bytes that turn out not to be text; the
 * page only offers the reader for the first kind, so the second is the one a person will see.
 */
async function view(req: IncomingMessage, res: ServerResponse, room: WebRoom, token: string): Promise<void> {
  const entry = room.resolveDownload(decodeURIComponent(token));
  if (!entry) return send(req, res, 404, { error: 'no such file' });
  const kind = readableKind(entry.name);
  if (!kind) return send(req, res, 415, { error: 'that kind of file is not shown here' });
  if (entry.ready) await entry.ready;
  const head = await readHead(entry.path, MAX_READ_BYTES);
  if (!head) return send(req, res, 404, { error: 'that file is no longer on disk' });
  const reading = renderReading(kind, head.bytes, head.size);
  if (!reading) return send(req, res, 415, { error: 'that file is not text' });
  send(req, res, 200, { name: entry.name, size: head.size, ...reading });
}

/** The first `limit` bytes of a file and its whole size, or `undefined` when it cannot be read. */
async function readHead(file: string, limit: number): Promise<{ bytes: Buffer; size: number } | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const bytes = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, bytesRead), size };
  } finally {
    await handle.close();
  }
}

/**
 * One file from the built asset directory — the page's own script and stylesheet, the code view's
 * entry module and its language chunks.
 *
 * This is the only route that serves a script off disk, and it serves only what
 * `scripts/build-webui-assets.mjs` wrote: `ASSET_FILE` is one path segment with no leading dot,
 * no separator and no `%`, and the resolved parent must still be the asset directory. Together
 * that leaves no spelling of `..` or of an encoded separator that reaches `readFile` with
 * anything but a name inside `dist/webui-assets/`.
 *
 * `immutable` because the name carries a content hash: the bytes behind a URL never change, and
 * a rebuild publishes a new name that the freshly rendered page points at. A declared type from
 * the extension (`ASSET_FILE` admits `.js` and `.css` only) rather than sniffing is the point of
 * the route — no agent-sent file can reach it, since a download is served as an octet-stream
 * attachment (see `download`) and never from here.
 */
async function asset(req: IncomingMessage, res: ServerResponse, assets: WebAssets, name: string): Promise<void> {
  if (!ASSET_FILE.test(name)) return send(req, res, 404, { error: 'no such asset' });
  const dir = path.resolve(assets.dir);
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== dir) return send(req, res, 404, { error: 'no such asset' });
  const bytes = await readFile(file).catch(() => undefined);
  if (!bytes) return send(req, res, 404, { error: 'no such asset' });
  const type = name.endsWith('.css')
    ? { 'Content-Type': 'text/css; charset=utf-8' }
    : { 'Content-Type': 'text/javascript; charset=utf-8' };
  body(req, res, 200, bytes, {
    ...type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ttyd's page and its little JSON endpoint, behind this server's session.
 *
 * Ordinary requests arrive here having already passed `route()`'s gate, so there is nothing
 * to check but whether the feature exists. The handshake that follows does NOT come through
 * here — see `upgrade()`.
 */
function terminalPage({ req, res, url }: Req, ctx: Ctx): void {
  if (!ctx.terminal.enabled) return send(req, res, 404, { error: 'no such route' });
  if (!topicArgsOk(url, ctx)) return send(req, res, 400, { error: 'no such topic' });
  proxyRequest(req, res, ctx.terminal.socket, ctx.upstreams);
}

/**
 * End one topic's terminal session, by running the command the operator configured.
 *
 * Separate from closing the pane, which the page does by itself: dropping the iframe ends a
 * connection, and a connection is not a session. This is the only route here that reaches
 * outside the process, and it reaches exactly as far as `terminal.endCommand` says.
 *
 * The topic is checked against the store even though the command cannot be made to mean
 * something else by an id that is merely unknown — because "which sessions may this page end"
 * should have the same answer as "which topics does this room have", and an id from a page
 * that has drifted out of date deserves a 404 rather than a subprocess.
 */
async function endTerminal({ req, res }: Req, ctx: Ctx): Promise<void> {
  if (!ctx.terminal.enabled) return send(req, res, 404, { error: 'no such route' });
  const parsed = await readBody(req, res, EndTerminalRequestSchema);
  if (!parsed) return;
  if (!ctx.room.topics.has(parsed.topic)) return send(req, res, 404, { error: 'no such topic' });
  // 501 rather than 404: the route exists and the request was fine — this deployment simply
  // never said what ending a session means. The page normally hides the button that gets here,
  // so anyone seeing this is holding a page older than the config.
  if (!ctx.terminal.sessions.canEnd) {
    return send(req, res, 501, { error: 'this daemon has no terminal.endCommand configured' });
  }
  const result = await ctx.terminal.sessions.end(parsed.topic);
  if (!result.ok) return send(req, res, 500, { error: result.error });
  send(req, res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// The file window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether this deployment has the file window at all.
 *
 * A route that exists while the feature is off answers 404, not 403 — the same choice the terminal
 * makes, and for the same reason: a page built before the operator turned it on should not be able
 * to tell "this daemon has no such thing" from "you may not use it". The page hides the button
 * either way; this is the answer to a hand-written request.
 */
function filesOn(ctx: Ctx): boolean {
  // `?.` because a hand-built instance in a test predates the field; the parsed config always has
  // it, and a missing block means "off", which is the safe answer.
  return ctx.instance.files?.enabled === true;
}

/** `topic` and `path` from a query string, checked by shape. Returns the pair or a reason. */
function filesQuery(url: URL): { topic: string; path: string } | { error: string } {
  const topic = url.searchParams.get('topic') ?? '';
  if (!TOPIC_ID.test(topic)) return { error: 'not a topic id' };
  const path = url.searchParams.get('path') ?? '';
  if (path.length > 4096) return { error: 'that path is too long' };
  return { topic, path };
}

/** One directory of a topic's machine. */
async function filesList({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const q = filesQuery(url);
  if ('error' in q) return send(req, res, 400, q);
  const r = await ctx.room.filesList(q.topic, q.path);
  send(req, res, r.ok ? 200 : 400, r);
}

/** One file, whole, or what it is instead (image, binary, too big). */
async function filesRead({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const q = filesQuery(url);
  if ('error' in q) return send(req, res, 400, q);
  const preview = url.searchParams.get('preview') === '1';
  const r = await ctx.room.filesRead(q.topic, q.path, preview);
  send(req, res, r.ok ? 200 : 400, r);
}

/** Filename matches, from git where there is a repository and a bounded walk where there is not. */
async function filesSearch({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const topic = url.searchParams.get('topic') ?? '';
  if (!TOPIC_ID.test(topic)) return send(req, res, 400, { error: 'not a topic id' });
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return send(req, res, 400, { error: 'a search needs a word to look for' });
  if (q.length > 200) return send(req, res, 400, { error: 'that search is too long' });
  const r = await ctx.room.filesSearch(topic, q);
  send(req, res, r.ok ? 200 : 400, r);
}

/**
 * One save. A conflict answers 409 with what the file is now, so the page can put the three
 * choices to the person instead of reporting a save that did not happen; everything else that
 * failed is 400 with the machine's own sentence.
 */
async function filesWrite({ req, res }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const parsed = await readBody(req, res, FilesWriteRequestSchema);
  if (!parsed) return;
  const r = await ctx.room.filesWrite(
    parsed.topic,
    parsed.path,
    parsed.text,
    parsed.force
      ? { force: true }
      : parsed.missing === true
        ? { missing: true }
        : {
            ...(parsed.mtimeMs !== undefined ? { mtimeMs: parsed.mtimeMs } : {}),
            ...(parsed.size !== undefined ? { size: parsed.size } : {}),
            ...(parsed.sha256 !== undefined ? { sha256: parsed.sha256 } : {}),
          }
  );
  send(req, res, r.ok ? 200 : 'conflict' in r ? 409 : 400, r);
}

/** A new empty file, or a new directory. */
async function filesCreate({ req, res }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const parsed = await readBody(req, res, FilesCreateRequestSchema);
  if (!parsed) return;
  const r = await ctx.room.filesCreate(parsed.topic, parsed.path, parsed.dir === true);
  send(req, res, r.ok ? 200 : 400, r);
}

/** Move or rename one entry. */
async function filesRename({ req, res }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const parsed = await readBody(req, res, FilesRenameRequestSchema);
  if (!parsed) return;
  const r = await ctx.room.filesRename(parsed.topic, parsed.from, parsed.to);
  send(req, res, r.ok ? 200 : 400, r);
}

/** Delete one file or one empty directory. */
async function filesRemove({ req, res }: Req, ctx: Ctx): Promise<void> {
  if (!filesOn(ctx)) return send(req, res, 404, { error: 'no such route' });
  const parsed = await readBody(req, res, FilesRemoveRequestSchema);
  if (!parsed) return;
  const r = await ctx.room.filesRemove(parsed.topic, parsed.path);
  send(req, res, r.ok ? 200 : 400, r);
}

// ─────────────────────────────────────────────────────────────────────────────
// The instruction editor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether this deployment has the instruction editor. 404 when off, for the file window's reason
 * (`filesOn`). The room's panel is checked too: the daemon hands it over only when the same switch
 * is on, so a route that got past this still finds nothing to act through.
 */
function instructionsOn(ctx: Ctx): boolean {
  return ctx.instance.instructions?.enabled === true;
}

function instructionsPanel(req: IncomingMessage, res: ServerResponse, ctx: Ctx): InstructionsPanel | undefined {
  const panel = instructionsOn(ctx) ? ctx.room.instructions : null;
  if (!panel) {
    send(req, res, 404, { error: 'no such route' });
    return undefined;
  }
  return panel;
}

/** The target a query string names, checked by shape. The daemon decides whether it exists. */
function instructionsTarget(url: URL): InstructionsTarget | { error: string } {
  const scope = url.searchParams.get('scope');
  if (scope === 'global') {
    const name = url.searchParams.get('name') ?? '';
    return name && name.length <= 64 ? { scope, name } : { error: 'not a file name' };
  }
  if (scope === 'agent') {
    const agent = url.searchParams.get('agent') ?? '';
    const path = url.searchParams.get('path') ?? '';
    if (!agent || agent.length > 128) return { error: 'not an agent id' };
    if (!path || path.length > 4096) return { error: 'not a path' };
    return { scope, agent, path };
  }
  return { error: 'scope must be global or agent' };
}

async function instructionsList({ req, res }: Req, ctx: Ctx): Promise<void> {
  const panel = instructionsPanel(req, res, ctx);
  if (!panel) return;
  send(req, res, 200, await panel.list());
}

/** One agent's referenced files: reads that agent's machine, so it is asked per agent, not listed. */
async function instructionsRefs({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const panel = instructionsPanel(req, res, ctx);
  if (!panel) return;
  const agent = url.searchParams.get('agent') ?? '';
  if (!agent || agent.length > 128) return send(req, res, 400, { error: 'not an agent id' });
  const r = await panel.refs(agent);
  send(req, res, r.ok ? 200 : 400, r);
}

async function instructionsRead({ req, res, url }: Req, ctx: Ctx): Promise<void> {
  const panel = instructionsPanel(req, res, ctx);
  if (!panel) return;
  const target = instructionsTarget(url);
  if ('error' in target) return send(req, res, 400, target);
  const r = await panel.read(target, { preview: url.searchParams.get('preview') === '1' });
  send(req, res, r.ok ? 200 : 400, r);
}

/** One save; a conflict answers 409, as the file window's does. */
async function instructionsWrite({ req, res }: Req, ctx: Ctx): Promise<void> {
  const panel = instructionsPanel(req, res, ctx);
  if (!panel) return;
  const parsed = await readBody(req, res, InstructionsWriteRequestSchema);
  if (!parsed) return;
  const target: InstructionsTarget =
    parsed.scope === 'global' ? { scope: 'global', name: parsed.name } : { scope: 'agent', agent: parsed.agent, path: parsed.path };
  const r = await panel.write(
    target,
    parsed.text,
    parsed.force
      ? { force: true }
      : parsed.missing === true
        ? { missing: true }
        : {
            ...(parsed.mtimeMs !== undefined ? { mtimeMs: parsed.mtimeMs } : {}),
            ...(parsed.size !== undefined ? { size: parsed.size } : {}),
            ...(parsed.sha256 !== undefined ? { sha256: parsed.sha256 } : {}),
          }
  );
  send(req, res, r.ok ? 200 : 'conflict' in r ? 409 : 400, r);
}

/**
 * The gate `route()` cannot be: an upgrade bypasses the request handler entirely.
 *
 * Everything `route()` does is redone here by hand, in the same order and for the same
 * reasons, because none of it is reachable from an upgrade event. A refusal writes a status
 * line and destroys the socket rather than leaving it open — a hung handshake is
 * indistinguishable to the page from a backend that is merely slow, and it holds a connection
 * open against the browser's per-origin limit for as long as the tab lives.
 */
function upgrade(req: IncomingMessage, socket: Socket, head: Buffer, ctx: Ctx): void {
  const url = new URL(req.url ?? '/', 'http://x');
  // `_http_server` removes its own error handler from the socket before emitting 'upgrade', so
  // between here and `proxyUpgrade` attaching one, this socket has none — and admission may now
  // await a key fetch. A client that resets the connection inside that window would otherwise
  // throw ECONNRESET with nobody listening, i.e. straight to the daemon's uncaught handler.
  socket.on('error', () => socket.destroy());
  // Nothing else here speaks WebSocket. Anything outside the terminal prefix is either a
  // probe or a future route that has not thought about this gate yet; both get nothing.
  if (!ctx.terminal.enabled || !url.pathname.startsWith('/term/')) return refuse(socket, 404, 'Not Found');
  // A WebSocket handshake is not subject to the same-origin policy and carries cookies
  // regardless of `SameSite` — so for this one route the Origin check is not the second lock
  // it is elsewhere, it is the only one. A missing Origin is refused here for the same reason
  // it is allowed in `sameOrigin`: no browser omits it on a handshake, so nothing legitimate
  // is turned away, and the curl-shaped caller that `sameOrigin` exists to permit has no
  // business opening this socket.
  //
  // Checked BEFORE admission, unlike the session in `route()`, because admission may now cost a
  // key fetch and this comparison is between two headers the caller sent anyway — it discloses
  // nothing and waiting on the provider to say no to it would be slower for no reason.
  if (!req.headers.origin || !sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
  void admitted(req, ctx).then(
    (ok) => {
      if (!ok) return refuse(socket, 401, 'Unauthorized');
      // Re-checked after the await: a socket the client gave up on in the meantime must not be
      // handed to ttyd, which would then hold a PTY open against a connection that is gone.
      if (socket.destroyed) return;
      // Whether a topic exists is answered only to someone already admitted. It is a weak
      // secret — four random bytes, and not a capability anywhere — but before this gate it
      // was no secret at all: 400 here and 401 for an id that does not exist is an oracle a
      // stranger could walk.
      if (!topicArgsOk(url, ctx)) return refuse(socket, 400, 'Bad Request');
      // Count this pane against its topic for as long as the socket lives, so the switcher can
      // mark which topics have a terminal attached. Only a handshake that is about to be
      // proxied is counted — a refusal above is not a pane, and counting one would light a
      // marker that nothing will ever put out.
      const arg = url.searchParams.get('arg');
      if (arg) ctx.terminal.sessions.attach(arg, socket);
      proxyUpgrade(req, socket, head, ctx.terminal.socket, ctx.upstreams);
    },
    () => refuse(socket, 500, 'Internal Server Error')
  );
}

/**
 * Every `?arg=` must name a topic this room actually has.
 *
 * ttyd is run with `--url-arg`, which hands whatever the URL carries to the command it
 * spawns. That is the feature that lets one ttyd serve a per-topic terminal, and it is also a
 * string from the browser arriving at an exec — so it is checked against the topic store
 * here, before ttyd ever sees it, and again by a pattern in the wrapper script on the far
 * side. Anything else, including a second arg nobody asked for, is refused.
 */
function topicArgsOk(url: URL, ctx: Ctx): boolean {
  const args = url.searchParams.getAll('arg');
  if (args.length > 1) return false;
  return args.every((arg) => ctx.room.topics.has(arg));
}

/** Whether the shared secret is still a way in. False only when SSO was told to be the only one. */
function passwordLogin(instance: WebuiInstance): boolean {
  return instance.sso?.password !== false;
}

/** Answer a rejected handshake and hang up. */
function refuse(socket: Socket, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// ─────────────────────────────────────────────────────────────────────────────
// Request plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One log line for a request this server turned away or lost.
 *
 * Until it existed a refused upload left nothing behind: the page was told (413, 400) and the log
 * said nothing, so "I sent a file and the agent never got it" could not be told apart from
 * "the file never left the browser" — which is the whole question when that is the complaint.
 */
function logRefused(req: IncomingMessage, why: string): void {
  console.warn(`[webui] ${req.method ?? '?'} ${(req.url ?? '').split('?')[0]}: ${why}`);
}

/**
 * Read, parse and validate a JSON body, answering the request itself on any failure.
 *
 * Returns `undefined` to mean "already answered, stop" — the alternative, throwing, would put
 * a routine oversized upload through the 500 path.
 *
 * `logRefusals` is opt-in, and only the send route asks for it: `api/login` is reachable without
 * a session, so a stranger's malformed bodies must not be able to write a line each into the log.
 */
async function readBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: Parameters<typeof parseBody<T>>[0],
  logRefusals = false
): Promise<T | undefined> {
  const refused = (why: string): void => {
    if (logRefusals) logRefused(req, `refused — ${why}`);
  };
  // Requiring JSON is half the CSRF story: a form or an <img> can only produce a simple
  // request, which cannot carry this content type without a preflight.
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    refused('content-type is not application/json');
    send(req, res, 415, { error: 'expected application/json' });
    return undefined;
  }
  const body = await readRaw(req, res, refused);
  if (!body) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    refused(`malformed JSON (${body.length} bytes)`);
    send(req, res, 400, { error: 'malformed JSON' });
    return undefined;
  }
  const parsed = parseBody(schema, raw);
  if (!parsed.ok) {
    refused(parsed.error);
    send(req, res, 400, { error: parsed.error });
    return undefined;
  }
  return parsed.value;
}

/**
 * Read a whole body up to `MAX_BODY_BYTES`, answering the request itself when it is over that or
 * the client goes away. `undefined` means "already answered (or nobody to answer), stop".
 */
async function readRaw(
  req: IncomingMessage,
  res: ServerResponse,
  refused: (why: string) => void
): Promise<Buffer | undefined> {
  const declared = req.headers['content-length'] ?? '?';
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        refused(`the body passed ${MAX_BODY_BYTES} bytes (Content-Length ${declared})`);
        send(req, res, 413, { error: 'that is too large to send' });
        req.destroy();
        return undefined;
      }
      chunks.push(buf);
    }
  } catch (e) {
    // The client went away mid-body — a page that timed an upload out and abandoned it, or a link
    // that dropped. Nobody is left to answer, and it is routine on the very links this page is
    // built for, so it is one line here rather than a stack trace from the route's catch-all.
    // The two numbers are what a stalled upload looks like from this side.
    refused(`the client hung up after ${size} of ${declared} bytes (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
  return Buffer.concat(chunks);
}

function isOctetStream(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/octet-stream';
}

/**
 * A send carrying files, as the page frames it: a 4-byte big-endian length, that many bytes of
 * JSON — the send request with each file's `data` replaced by its `size` — then every file's bytes
 * in order. Turned back into the JSON request (`data` as base64) and validated by its schema.
 *
 * As safe against a cross-site form as the JSON body is: `application/octet-stream` is not one of
 * the three types a form or a simple request can send, so a cross-origin page cannot post it
 * without a preflight, and `sameOrigin` and the cookie's `SameSite=Strict` apply as to any POST.
 * The framing is checked exactly — the sizes must add up to the bytes that follow, to the byte — so
 * nothing in the body goes unaccounted for.
 */
async function readFramedSend(req: IncomingMessage, res: ServerResponse): Promise<SendRequest | undefined> {
  const refused = (why: string): void => logRefused(req, `refused — ${why}`);
  const malformed = (why: string): undefined => {
    refused(why);
    send(req, res, 400, { error: `malformed upload: ${why}` });
    return undefined;
  };
  const body = await readRaw(req, res, refused);
  if (!body) return undefined;
  if (body.length < 4) return malformed('no header');
  const headerLength = body.readUInt32BE(0);
  if (4 + headerLength > body.length) return malformed('the header runs past the body');
  let header: unknown;
  try {
    header = JSON.parse(body.subarray(4, 4 + headerLength).toString('utf8')) as unknown;
  } catch {
    return malformed('the header is not JSON');
  }
  const shape = parseBody(FramedSendHeaderSchema, header);
  if (!shape.ok) return malformed(shape.error);
  const { files, ...rest } = shape.value;
  let at = 4 + headerLength;
  if (files.reduce((n, f) => n + f.size, 0) !== body.length - at) {
    return malformed(`the files' sizes do not add up to the ${body.length - at} bytes sent`);
  }
  const request = {
    ...rest,
    files: files.map((f) => {
      const data = body.subarray(at, at + f.size).toString('base64');
      at += f.size;
      return { name: f.name, mime: f.mime, data };
    }),
  };
  const parsed = parseBody(SendRequestSchema, request);
  if (!parsed.ok) return malformed(parsed.error);
  return parsed.value;
}

/**
 * Refuse a state-changing request that a different origin sent.
 *
 * The session cookie is already `SameSite=Strict`, so a browser will not attach it cross-site;
 * this is the second lock, and the one that still works if that attribute is ever relaxed. A
 * missing `Origin` is allowed through: `curl` and the reverse CLI send none, and they are not
 * the threat this is about.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Whether the request reached us over TLS, including via a proxy that says so. */
function isSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? '').split(',')[0]?.trim() === 'https';
}

function acceptsGzip(req: IncomingMessage): boolean {
  const accept = req.headers['accept-encoding'];
  return (Array.isArray(accept) ? accept.join(',') : (accept ?? '')).includes('gzip');
}

/**
 * Whether `Accept-Encoding` names this coding with a q above zero. Parsed rather than searched for,
 * unlike `acceptsGzip`: "br" is two letters, and "br;q=0" is a client saying no.
 */
function accepts(req: IncomingMessage, coding: string): boolean {
  const accept = req.headers['accept-encoding'];
  const list = Array.isArray(accept) ? accept.join(',') : (accept ?? '');
  return list.split(',').some((item) => {
    const [name, ...params] = item.split(';').map((s) => s.trim().toLowerCase());
    if (name !== coding) return false;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function send(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
  body(req, res, status, Buffer.from(JSON.stringify(payload), 'utf8'), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

/** Write a finished response, compressed when it is worth it and the client will take it. */
function body(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: Buffer,
  headers: Record<string, string>
): void {
  const compress = payload.length >= MIN_COMPRESS_BYTES && acceptsGzip(req);
  const out = compress ? gzipSync(payload) : payload;
  res.writeHead(status, {
    ...headers,
    'Content-Length': out.length,
    ...(compress ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
  });
  res.end(out);
}

/**
 * `body`, with the gzip done on libuv's pool instead of the event loop.
 *
 * Every other answer here is small enough that `gzipSync` costs less than a turn of the loop.
 * A topic snapshot is not: 1.5 MB of JSON, and compressing it synchronously would stall every
 * event stream in the process for the duration — including the one the page asking for it is
 * reading. A compression failure is not a reason to fail the request: the client gets it plain.
 */
function sendAsyncGzip(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): Promise<void> {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (raw.length < MIN_COMPRESS_BYTES || !acceptsGzip(req)) {
    res.writeHead(status, { ...headers, 'Content-Length': raw.length });
    res.end(raw);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    gzip(raw, (e, out) => {
      if (e) console.warn(`[webui] could not gzip an answer, sending it plain: ${e.message}`);
      const body = e ? raw : out;
      res.writeHead(status, {
        ...headers,
        'Content-Length': body.length,
        ...(e ? {} : { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }),
      });
      res.end(body);
      resolve();
    });
  });
}
