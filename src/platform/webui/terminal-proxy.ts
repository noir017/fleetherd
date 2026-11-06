/**
 * A reverse proxy to the `ttyd` behind the terminal pane, over a unix socket.
 *
 * ── Why the terminal is not built here ───────────────────────────────────────
 * Nothing in this daemon has raw terminal output to offer. The agent runtime spawns its
 * child over plain pipes and reads strictly line-delimited JSON (`agent-acp.ts`); a line that
 * does not parse is dropped, and the ACP handshake even declares
 * `terminal: false`. A pane showing "the command line" therefore cannot tap the agent — it has
 * to be a second, parallel thing: a real PTY, and a terminal emulator in the browser.
 *
 * Building that here would mean a native PTY binding (the first compiled dependency in the
 * tree — and node-pty publishes no Linux prebuilds, so every Linux install would need a
 * toolchain), plus xterm.js, plus a WebSocket server, plus scrollback, resize, reconnect and a
 * mobile key bar. `ttyd` is 1.3 MB of static binary that already does all of it, with CJK and
 * IME support this page would otherwise have to re-earn. So the daemon owns none of it and
 * proxies instead: the operator's image runs ttyd on a unix socket, and this file is the door.
 *
 * The consequence worth stating plainly: what the pane shows is whatever that ttyd was told to
 * run. That is the whole reason it works with any coding-agent CLI, and also why nothing in it
 * reaches the conversation — no transcript, no reverse CLI, no topic history.
 *
 * ── Why a unix socket ────────────────────────────────────────────────────────
 * Not a port. Nothing on the network can reach a socket file, so the session check in
 * `server.ts` is the only way in rather than one of two — there is no second door left open by
 * a firewall rule nobody wrote.
 *
 * ── Two things that must not happen ──────────────────────────────────────────
 * Responses are passed through byte for byte. ttyd compresses its own 730 KB single-file page
 * down to ~190 KB and says so in `Content-Encoding`; running that back through this server's
 * `body()` would gzip a gzip and hand the browser something it cannot read.
 *
 * And every upstream socket is destroyed when its downstream dies, in both directions. An
 * orphaned connection to ttyd would keep `server.close()` from ever calling back — the same
 * trap the event stream has, with the same symptom: Ctrl-C hangs forever rather than leaking
 * quietly. `server.test.ts` pins it.
 */
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/** Upstreams currently in flight, so `stop()` can end them rather than wait on them. */
export type UpstreamSet = Set<Socket>;

/**
 * Forward an ordinary request and stream the answer back untouched.
 *
 * Headers are copied in both directions rather than rebuilt: `Host` and `Origin` have to
 * arrive at ttyd exactly as the browser sent them or its own `--check-origin` refuses the
 * handshake that follows, and the response's `Content-Encoding` has to survive for the page to
 * decode at all.
 */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  socketPath: string,
  upstreams: UpstreamSet
): void {
  const up = request(
    {
      socketPath,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers: req.headers,
      // No connection pool. The default global agent keeps sockets alive for reuse, which
      // across a unix socket buys nothing measurable and costs the one property that matters
      // here: an idle pooled connection is still a connection, so `server.close()` waits on
      // it and ttyd holds a client it is not serving. One request, one socket, gone when the
      // response is.
      agent: false,
    },
    (upRes) => {
      // ttyd has no opinion about who may frame its page, and this one is framed on purpose —
      // by our own page, same-origin. Saying so is what keeps a third-party site from framing a
      // live terminal and collecting clicks on it: the session cookie is `SameSite=Strict` and
      // would not travel there, but an SSO deployment's cookie belongs to the proxy in front and
      // may well be `SameSite=None`. Both headers, because `frame-ancestors` is the modern one
      // and `X-Frame-Options` is what an older browser reads.
      res.writeHead(upRes.statusCode ?? 502, {
        ...upRes.headers,
        'Content-Security-Policy': "frame-ancestors 'self'",
        'X-Frame-Options': 'SAMEORIGIN',
      });
      upRes.pipe(res);
    }
  );
  up.on('socket', (socket) => track(upstreams, socket));
  up.on('error', (e: Error) => {
    // The commonest cause by far is ENOENT: the feature is on and ttyd is not running. Say
    // which, because "502" alone sends the operator looking at the wrong process.
    console.warn(`[webui] terminal upstream unreachable (${socketPath}): ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('terminal backend is not running');
  });
  // A client that goes away mid-body must take the upstream with it — but `close` fires on a
  // finished response too, and tearing that one down would abort a transfer that succeeded.
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}

/**
 * Forward a WebSocket handshake and then get out of the way.
 *
 * After the 101 this is a blind byte pipe in both directions — which is the entire reason this
 * file needs no WebSocket library. Nothing here parses a frame, masks a payload or computes an
 * accept key; ttyd does all of that, and the bytes are none of our business.
 *
 * `res.headers` from the upstream are replayed verbatim into the 101 rather than reconstructed,
 * because `Sec-WebSocket-Accept` is derived from the key the browser chose and
 * `Sec-WebSocket-Protocol` is ttyd's answer about which subprotocol it took. Inventing either
 * is a handshake the browser rejects.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  socketPath: string,
  upstreams: UpstreamSet
): void {
  const up = request({ socketPath, path: req.url ?? '/', method: 'GET', headers: req.headers, agent: false });

  up.on('upgrade', (upRes, upSocket, upHead) => {
    track(upstreams, upSocket);
    const status = `HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`;
    const lines = Object.entries(upRes.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((one) => `${k}: ${one}`) : v === undefined ? [] : [`${k}: ${v}`]
    );
    socket.write(`${status}\r\n${lines.join('\r\n')}\r\n\r\n`);

    // Bytes that arrived glued to the handshake on either side, before the pipes exist. Both
    // are usually empty and both are occasionally not; dropping them loses the first keystroke
    // or the first frame of output, which looks like a terminal that silently missed input.
    if (upHead.length > 0) socket.write(upHead);
    if (head.length > 0) upSocket.write(head);

    socket.pipe(upSocket);
    upSocket.pipe(socket);
    bindTeardown(socket, upSocket);
  });

  // ttyd answering with an ordinary response to an upgrade means it refused the handshake.
  // Relay its status rather than inventing one, then end it — there is no protocol left.
  up.on('response', (upRes) => {
    socket.end(`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? 'Bad Gateway'}\r\n\r\n`);
    up.destroy();
  });

  up.on('error', (e: Error) => {
    console.warn(`[webui] terminal upstream unreachable (${socketPath}): ${e.message}`);
    socket.destroy();
  });
  // Before the 101 there is no pair to tear down yet, so the handshake's own socket carries
  // the upstream request. `end` for the same reason as in `bindTeardown`: a FIN is what a
  // browser sends, and it does not arrive as `close`.
  for (const ev of ['error', 'close', 'end'] as const) socket.on(ev, () => up.destroy());
  up.end();
}

/** Remember an upstream for the lifetime of its socket, so shutdown has something to destroy. */
function track(upstreams: UpstreamSet, socket: Socket): void {
  upstreams.add(socket);
  socket.on('close', () => upstreams.delete(socket));
}

/**
 * Either half going away ends the other. Neither side outlives the pair.
 *
 * `end` is in that list and is the one that matters. A browser closing the tab sends a FIN,
 * and an `http.Server` socket reports a FIN as `end` — not `close`, because its own write side
 * is still open, so it sits there half-open indefinitely. Listening for `close` alone
 * therefore leaks a socket pair per closed terminal and leaves `server.close()` waiting on
 * every one of them. Measured rather than assumed: with `close` alone the pair outlived a
 * client `destroy()` by a full second and the close callback never fired.
 */
function bindTeardown(a: Socket, b: Socket): void {
  const end = (): void => {
    a.destroy();
    b.destroy();
  };
  for (const ev of ['close', 'end', 'error'] as const) {
    a.on(ev, end);
    b.on(ev, end);
  }
}
