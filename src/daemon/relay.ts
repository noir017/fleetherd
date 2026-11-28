import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import type { AgentDef } from '../config/schema.js';
import type { RelayHeaderObserver, RelayTransform, RemoteHost } from '../remote/host.js';
import { expandEnv } from './agent-common.js';
import { HARNESS_PROFILES } from './harness/index.js';
import type { HarnessRelay, RelaySpec } from './relay-types.js';

/**
 * Relays: a loopback HTTP listener between an agent and its API, for a harness whose endpoint an
 * environment variable can redirect. Everything is forwarded as it is — the model calls stream
 * through untouched — except the responses on a few named paths, which a transform sees first and
 * may replace. That is the whole mechanism, and it knows nothing of any harness: what a harness's
 * relay is for, and what its transform changes, is the harness's file (agy-relay.ts).
 *
 * Where the agent runs decides where the relay runs, so its model calls never leave that machine:
 * on this one, the listener below; on a remote host, fleetherd-remote's (remote/relay.go), which hands
 * the named responses back here over the link and so keeps every transform in this one place.
 *
 * A relay that cannot be opened is said in the log and the agent starts without one, on its
 * harness's own settings — a degraded agent, not a failed start.
 */

/** The relay an agent runs behind, if its harness and settings call for one. */
const headerWatchers = new Map<string, (headers: Record<string, string>) => void>();
const relayHeaderDispatch: RelayHeaderObserver = (tag, headers) => {
  headerWatchers.get(tag)?.(headers);
};
const relayWarnings = new Set<string>();

function warnRelayOnce(key: string, message: string): void {
  if (relayWarnings.has(key)) return;
  relayWarnings.add(key);
  console.warn(message);
}

function quotaHeaderRelay(def: AgentDef, existing: HarnessRelay | undefined): HarnessRelay | undefined {
  const cfg = def.quotaAccountHeader;
  if (!cfg) return existing;
  const header = cfg.header.trim().toLowerCase();
  const envVar = cfg.env ?? HARNESS_PROFILES[def.harness].gatewayEnvVar;
  if (!envVar) {
    warnRelayOnce(`${def.id}:noenv`, `[relay] ${def.id}: quotaAccountHeader needs env (no default gateway env var for harness "${def.harness}")`);
    return existing;
  }
  if (existing && existing.envVar === envVar) {
    const merged = [...new Set([...(existing.spec.observeHeaders ?? []), header])].sort();
    return {
      envVar,
      spec: { ...existing.spec, observeHeaders: merged, onHeaders: relayHeaderDispatch },
    };
  }
  const raw = def.env[envVar];
  if (!raw) {
    warnRelayOnce(`${def.id}:nourl`, `[relay] ${def.id}: quotaAccountHeader needs ${envVar} in agent env; no relay started`);
    return existing;
  }
  const upstream = expandEnv(raw).replace(/\/$/, '');
  const id = `hdr.${createHash('sha256').update(`${envVar}\n${upstream}\n${header}`).digest('hex').slice(0, 8)}`;
  return {
    envVar,
    spec: {
      id,
      upstream,
      paths: [],
      transform: () => undefined,
      observeHeaders: [header],
      onHeaders: relayHeaderDispatch,
    },
  };
}

export function harnessRelay(def: AgentDef): HarnessRelay | undefined {
  const base = HARNESS_PROFILES[def.harness].relay?.(def);
  return quotaHeaderRelay(def, base);
}

export interface OpenedRelay {
  env: Record<string, string>;
  dispose: () => void;
}

export async function openAgentRelay(
  def: AgentDef,
  host?: RemoteHost,
  onHeaders?: (headers: Record<string, string>) => void
): Promise<OpenedRelay> {
  const r = harnessRelay(def);
  if (!r) return { env: {}, dispose: () => {} };
  const { id, upstream, paths, transform, observeHeaders, onHeaders: relayObserver } = r.spec;
  try {
    const observer = observeHeaders?.length ? (relayObserver ?? relayHeaderDispatch) : undefined;
    const url = host
      ? await host.relay(id, upstream, paths, transform, observer ? { observeHeaders, onHeaders: observer } : undefined)
      : await openLocalRelay(observer ? { ...r.spec, onHeaders: observer } : r.spec);
    if (observeHeaders?.length && onHeaders) {
      const tag = randomBytes(8).toString('hex');
      headerWatchers.set(tag, onHeaders);
      return {
        env: { [r.envVar]: `${url}/__s/${tag}` },
        dispose: () => {
          headerWatchers.delete(tag);
        },
      };
    }
    return { env: { [r.envVar]: url }, dispose: () => {} };
  } catch (e) {
    console.warn(
      `[relay] agent "${def.id}": could not open its relay to ${upstream} (${(e as Error).message}); it starts without one, on its harness's own settings`
    );
    return { env: {}, dispose: () => {} };
  }
}

/**
 * The environment that puts an agent behind its relay — on `host` when it runs there — or `{}` when
 * it has none, or one could not be opened.
 */
export async function relayEnv(def: AgentDef, host?: RemoteHost): Promise<Record<string, string>> {
  return (await openAgentRelay(def, host)).env;
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
  onHeaders?: RelayHeaderObserver;
  server: http.Server;
}

/** One listener per relay id for the life of the process; a changed spec replaces it. */
const localRelays = new Map<string, LocalRelay>();

function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

const RELAY_TAG_PREFIX = '/__s/';

function stripRelayTag(rawUrl: string): { tag: string | undefined; strippedUrl: string; strippedPath: string } {
  const q = rawUrl.indexOf('?');
  const rawPath = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const query = q >= 0 ? rawUrl.slice(q) : '';
  if (!rawPath.startsWith(RELAY_TAG_PREFIX)) {
    return { tag: undefined, strippedUrl: rawUrl, strippedPath: rawPath };
  }
  const tail = rawPath.slice(RELAY_TAG_PREFIX.length);
  const slash = tail.indexOf('/');
  const tag = slash >= 0 ? tail.slice(0, slash) : tail;
  const rest = slash >= 0 ? tail.slice(slash) : '/';
  return { tag: tag || undefined, strippedUrl: rest + query, strippedPath: rest };
}

function collectObservedHeaders(headers: http.IncomingHttpHeaders, observe: readonly string[]): Record<string, string> | undefined {
  let found: Record<string, string> | undefined;
  for (const name of observe) {
    const raw = headers[name];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (val) {
      found ??= {};
      found[name] = val;
    }
  }
  return found;
}

/** A relay on this machine, for an agent that runs here; resolves to its URL. */
export function openLocalRelay(spec: RelaySpec): Promise<string> {
  const target = new URL(spec.upstream);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    return Promise.reject(new Error(`relay upstream ${spec.upstream}: scheme must be https (or http on loopback)`));
  }
  const observe = [...new Set((spec.observeHeaders ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))].sort();
  const key = `${target.href}\n${[...spec.paths].sort().join('\n')}\n${observe.join('\n')}`;
  const have = localRelays.get(spec.id);
  if (have?.key === key) {
    have.transform = spec.transform;
    have.onHeaders = spec.onHeaders;
    return have.url;
  }
  have?.server.close();

  const client = target.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true });
  const base = target.pathname.replace(/\/$/, '');
  const named = new Set(spec.paths);
  const entry = { key, transform: spec.transform, onHeaders: spec.onHeaders } as LocalRelay;

  entry.server = http.createServer((req, res) => {
    const { tag, strippedUrl, strippedPath: path } = stripRelayTag(req.url ?? '/');
    const intercept = named.has(path);
    const headers = { ...endToEnd(req.headers), host: target.host };
    // Without it the upstream answers uncompressed, and the transform is shown the body itself.
    if (intercept) delete headers['accept-encoding'];
    const up = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: base + strippedUrl, method: req.method, headers, agent },
      (ur) => {
        if (tag && observe.length > 0 && entry.onHeaders) {
          const found = collectObservedHeaders(ur.headers, observe);
          if (found) entry.onHeaders(tag, found);
        }
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
