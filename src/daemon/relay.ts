import http from 'node:http';
import https from 'node:https';
import type { AgentDef } from '../config/schema.js';
import type { RelayTransform, RemoteHost } from '../remote/host.js';
import { agyRelay } from './agy-relay.js';

/**
 * Relays: a loopback HTTP listener between an agent and its API, for a harness whose endpoint an
 * environment variable can redirect. Everything is forwarded as it is — the model calls stream
 * through untouched — except the responses on a few named paths, which a transform sees first and
 * may replace. That is the whole mechanism, and it knows nothing of any harness: what a harness's
 * relay is for, and what its transform changes, is the harness's file (agy-relay.ts).
 *
 * Where the agent runs decides where the relay runs, so its model calls never leave that machine:
 * on this one, the listener below; on a remote host, talkcode-remote's (remote/relay.go), which hands
 * the named responses back here over the link and so keeps every transform in this one place.
 *
 * A relay that cannot be opened is said in the log and the agent starts without one, on its
 * harness's own settings — a degraded agent, not a failed start.
 */

export interface RelaySpec {
  /** Names the relay; agents with the same spec share one. A safe name (remote/paths.go safeName). */
  id: string;
  /** Where it forwards to: https, or http on loopback (a local proxy to chain to, or a test). */
  upstream: string;
  /** Responses on these paths are handed to `transform` before the agent sees them. */
  paths: readonly string[];
  transform: RelayTransform;
}

/** A harness's use of a relay: the spec, and the variable that points the harness at it. */
export interface HarnessRelay {
  envVar: string;
  spec: RelaySpec;
}

/** The relay an agent runs behind, if its harness and settings call for one. */
export function harnessRelay(def: AgentDef): HarnessRelay | undefined {
  switch (def.harness) {
    case 'agy':
      return agyRelay(def);
    case 'claude':
    case 'gemini':
    case 'codex':
    case 'opencode':
    case 'dsh':
    case 'custom':
      return undefined;
    default: {
      const _exhaustive: never = def.harness;
      return _exhaustive;
    }
  }
}

/**
 * The environment that puts an agent behind its relay — on `host` when it runs there — or `{}` when
 * it has none, or one could not be opened.
 */
export async function relayEnv(def: AgentDef, host?: RemoteHost): Promise<Record<string, string>> {
  const r = harnessRelay(def);
  if (!r) return {};
  const { id, upstream, paths, transform } = r.spec;
  try {
    const url = host ? await host.relay(id, upstream, paths, transform) : await openLocalRelay(r.spec);
    return { [r.envVar]: url };
  } catch (e) {
    console.warn(
      `[relay] agent "${def.id}": could not open its relay to ${upstream} (${(e as Error).message}); it starts without one, on its harness's own settings`
    );
    return {};
  }
}

// ───────────────────────── the local listener ─────────────────────────

/** The same cap as remote/relay.go: a bigger response is passed on rather than held. */
const MAX_BODY = 8 << 20;

/** Connection-scoped headers, never forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

interface LocalRelay {
  key: string;
  url: Promise<string>;
  transform: RelayTransform;
  server: http.Server;
}

/** One listener per relay id for the life of the process; a changed spec replaces it. */
const localRelays = new Map<string, LocalRelay>();

function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

/** A relay on this machine, for an agent that runs here; resolves to its URL. */
export function openLocalRelay(spec: RelaySpec): Promise<string> {
  const target = new URL(spec.upstream);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    return Promise.reject(new Error(`relay upstream ${spec.upstream}: scheme must be https (or http on loopback)`));
  }
  const key = `${target.href}\n${[...spec.paths].sort().join('\n')}`;
  const have = localRelays.get(spec.id);
  if (have?.key === key) {
    have.transform = spec.transform;
    return have.url;
  }
  have?.server.close();

  const client = target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true });
  const base = target.pathname.replace(/\/$/, '');
  const named = new Set(spec.paths);
  const entry = { key, transform: spec.transform } as LocalRelay;

  entry.server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const intercept = named.has(path);
    const headers = { ...endToEnd(req.headers), host: target.host };
    // Without it the upstream answers uncompressed, and the transform is shown the body itself.
    if (intercept) delete headers['accept-encoding'];
    const up = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: base + (req.url ?? '/'), method: req.method, headers, agent },
      (ur) => {
        if (!intercept || ur.statusCode !== 200 || ur.headers['content-encoding']) {
          res.writeHead(ur.statusCode ?? 502, endToEnd(ur.headers));
          ur.pipe(res);
          return;
        }
        serveTransformed(entry, path, ur, res);
      }
    );
    up.on('error', (e) => {
      console.warn(`[relay] ${spec.id}: ${req.method} ${path} to ${target.host} failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    // The agent gave up (a cancelled turn): stop the upstream call with it.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    req.pipe(up);
  });
  entry.server.unref();
  entry.url = new Promise<string>((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(0, '127.0.0.1', () => {
      const addr = entry.server.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
      else reject(new Error('relay listener has no address'));
    });
  });
  entry.url.catch(() => localRelays.delete(spec.id));
  localRelays.set(spec.id, entry);
  return entry.url;
}

/**
 * Collect a named response and serve what the transform makes of it. Too big, or a transform that
 * throws or declines: the response as it came.
 *
 * Events rather than `for await`: leaving that loop early destroys the stream, and a response over
 * the cap has to go on being piped, not cut.
 */
function serveTransformed(entry: LocalRelay, path: string, ur: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  let size = 0;
  const onData = (b: Buffer): void => {
    chunks.push(b);
    size += b.length;
    if (size <= MAX_BODY) return;
    ur.off('data', onData);
    ur.off('end', onEnd);
    console.warn(`[relay] ${path} answered more than ${MAX_BODY} bytes; passed on unchanged`);
    res.writeHead(200, endToEnd(ur.headers));
    for (const c of chunks) res.write(c);
    ur.pipe(res);
  };
  const onEnd = (): void => void finish(Buffer.concat(chunks));
  const finish = async (original: Buffer): Promise<void> => {
    let body = original;
    try {
      const out = await entry.transform(path, original);
      if (out && out.length > 0) body = out;
    } catch (e) {
      console.warn(`[relay] transforming ${path} failed (${(e as Error).message}); passed on unchanged`);
    }
    res.writeHead(200, { ...endToEnd(ur.headers), 'content-length': String(body.length) });
    res.end(body);
  };
  ur.on('data', onData);
  ur.on('end', onEnd);
  ur.on('error', (e) => res.destroy(e));
}
