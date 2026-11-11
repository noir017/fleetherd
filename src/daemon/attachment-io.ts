import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Config } from '../config/schema.js';
import { configDir } from '../config/load.js';
import type { AttachmentIngestDeps } from '../core/attachment-ingest.js';
import type { RemoteHost } from '../remote/host.js';

/**
 * Build attachment IO deps (daemon layer does real IO; core's attachment-ingest stays pure).
 *  - download: the platform's own fetcher when it claims the URL, else Node global fetch with an
 *    AbortController timeout and a content-length early-exit over maxDownloadBytes; returns bytes
 *    plus whatever was learned about them (content-type header, filename).
 *  - save: write to the cache dir (config.cacheDir defaults to `attachments` in the config directory); filename
 *    sanitized against traversal, short hash prefix to avoid overwrite; mkdir recursive + writeFile.
 *
 * `fetchPlatform` is the adapter's `fetchAttachment` (absent for platforms whose media URLs are
 * public https links, which is seven of the eight). See PlatformProfile.fetchAttachment.
 */
export function createAttachmentIngestDeps(
  config: Config,
  fetchPlatform?: (
    url: string
  ) => Promise<{ bytes: Uint8Array; mime?: string; name?: string } | undefined>
): AttachmentIngestDeps {
  const maxDownloadBytes = config.attachments.maxDownloadBytes;
  const cacheDir = config.attachments.cacheDir ?? path.join(configDir(), 'attachments');

  return {
    download: async (url) => {
      // A platform whose inbound media lives behind its own API (Lark hands out
      // `internal:lark/…` resource addresses) fetches through its authenticated client. Tried
      // FIRST, and only for URLs it recognizes — `undefined` means "not mine" and falls through.
      //
      // Security: this does NOT weaken the SSRF invariant below. That guard exists because a
      // message can name any host it likes; here the message names only a path segment (validated
      // against the id alphabet in the profile) and the request goes to the vendor endpoint the
      // operator configured, with the bot's own token. What the guard *does* still owe us is the
      // size cap, enforced here: this route reports no content-length to pre-check, so the bytes
      // are already in memory when we can measure them.
      if (fetchPlatform) {
        const got = await fetchPlatform(url);
        if (got) {
          if (got.bytes.length > maxDownloadBytes) {
            throw new Error(`download size ${got.bytes.length} exceeds maxDownloadBytes`);
          }
          return {
            bytes: got.bytes,
            ...(got.mime ? { contentType: got.mime } : {}),
            ...(got.name ? { name: got.name } : {}),
          };
        }
      }
      // A `data:` URL carries the bytes inline instead of naming somewhere to fetch them from.
      // Satori's adapters produce these for platforms whose media sits behind an authenticated API:
      // adapter-telegram downloads the file with the bot token and hands it over as
      // `data:<mime>;base64,…` (adapter-telegram 4.5.11, src/bot.ts:169), so this is the shape EVERY
      // inbound Telegram photo arrives in.
      //
      // Security: this does not weaken the SSRF invariant below, because there is nothing for it to
      // act on — no host, no DNS lookup, no request. The guard rejects `data:` precisely so a URL
      // cannot be coerced into reading something local, and a payload that is already in hand reads
      // nothing. The size cap is the limit that does apply here, and it is enforced before the bytes
      // go any further.
      const inline = decodeDataUrl(url);
      if (inline) {
        if (inline.bytes.length > maxDownloadBytes) {
          throw new Error(`download size ${inline.bytes.length} exceeds maxDownloadBytes`);
        }
        return inline;
      }
      // SSRF block: the url comes from an inbound IM attachment (user-controlled), so validate scheme and
      // target before fetch and reject internal/loopback/cloud-metadata endpoints. On hit, throw (caught
      // upstream, attachment skipped). Normal platform CDNs (public https domains) are unaffected.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      try {
        // Follow redirects manually so EVERY hop is re-validated: a 3xx Location can otherwise bounce a
        // public CDN URL to an internal/loopback/cloud-metadata address that the initial check passed
        // (redirect:'follow' would chase it unchecked). Re-resolve the guard against each target.
        let current = url;
        let res: Response;
        for (let hop = 0; ; hop++) {
          await assertSafeAttachmentUrl(current);
          res = await fetch(current, { signal: controller.signal, redirect: 'manual' });
          const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (location === null) break;
          if (hop >= MAX_ATTACHMENT_REDIRECTS) {
            throw new Error(`too many attachment redirects (> ${MAX_ATTACHMENT_REDIRECTS})`);
          }
          // Resolve relative Location against the current URL; the next loop re-validates it.
          current = new URL(location, current).toString();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // content-length early-exit: don't download the body if the declared length exceeds the threshold.
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len) && len > maxDownloadBytes) {
          throw new Error(`content-length ${len} exceeds maxDownloadBytes`);
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > maxDownloadBytes) {
          throw new Error(`download size ${buf.length} exceeds maxDownloadBytes`);
        }
        return { bytes: buf, contentType: res.headers.get('content-type') ?? undefined };
      } finally {
        clearTimeout(timer);
      }
    },
    save: async (name, bytes) => {
      await mkdir(cacheDir, { recursive: true });
      // Anti-traversal: strip any path separators, keep only the basename.
      const safe = sanitizeFilename(name);
      // Content short-hash prefix to avoid same-name overwrites.
      const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
      const finalName = `${hash}-${safe}`;
      const dest = path.join(cacheDir, finalName);
      await writeFile(dest, bytes);
      return dest;
    },
  };
}

/**
 * `save` for an agent on a remote host: the file goes to THAT host — `~/.fleetherd/attachments`,
 * owner-only, named the same way as a local save — and the path the prompt names is the one the
 * agent can open there. The download itself still happens here, behind the same SSRF guards.
 */
export function remoteAttachmentSave(host: RemoteHost): AttachmentIngestDeps['save'] {
  return async (name, bytes) => {
    const w = await host.ready();
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
    const dest = `${w.home}/.fleetherd/attachments/${hash}-${sanitizeFilename(name)}`;
    await host.writeFile(dest, bytes, 0o600);
    return dest;
  };
}

/** Per-attachment download timeout (ms). */
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Max redirect hops to follow during an attachment download (each hop is SSRF-re-validated). */
const MAX_ATTACHMENT_REDIRECTS = 5;

/**
 * The bytes a `data:` URL carries, or nothing if this is not one.
 *
 * Exported for its tests. Deliberately strict about the prefix and forgiving about the payload: an
 * adapter builds these itself (never a remote peer), so the risk worth guarding is mistaking some
 * other scheme for one of these, not a malformed body — which simply decodes to fewer bytes.
 */
export function decodeDataUrl(url: string): { bytes: Uint8Array; contentType?: string } | undefined {
  const head = /^data:([^;,]*)((?:;[^,]*)*),/.exec(url);
  if (!head) return undefined;
  const payload = url.slice(head[0].length);
  const base64 = /;base64/i.test(head[2] ?? '');
  const bytes = base64
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'));
  const contentType = head[1] || undefined;
  return { bytes, ...(contentType ? { contentType } : {}) };
}

/**
 * SSRF protection for an attachment download URL (called before download, throws on hit).
 *
 * Two gates:
 *   1) scheme must be http/https (reject file:/ftp:/data:/gopher: etc. that could be coerced to read local/internal).
 *   2) target must not point at a private/loopback/link-local range. Literal IP hosts are checked
 *      directly; domains are DNS-resolved (IPv4 and IPv6) and rejected if any result lands in a private
 *      range — blocking DNS-rebinding-style bypass where a public domain's A record points internal.
 *
 * Minimal internal-block only, no allowlist; normal platform CDNs (public https domains) are unaffected.
 */
export async function assertSafeAttachmentUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid attachment URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to download non-http(s) attachment: ${parsed.protocol}`);
  }
  // Strip IPv6 literal brackets ([::1] → ::1).
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`refusing to download attachment pointing at a private/loopback address: ${host}`);
    }
    return;
  }
  // Domain: resolve all A/AAAA records, reject if any lands in a private range (DNS-to-internal bypass).
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve attachment hostname: ${host}`);
  }
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new Error(`refusing to download: host ${host} resolves to a private/loopback address ${address}`);
    }
  }
}

/**
 * Whether a literal IP is in a private/loopback/link-local/unspecified range (IPv4 + IPv6).
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (incl. cloud metadata
 * 169.254.169.254), 0.0.0.0; and ::1, :: (unspecified), fc00::/7 (ULA), fe80::/10 (link-local), and
 * IPv4-mapped ::ffff:a.b.c.d (judged by its IPv4 part).
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // IPv4-mapped (::ffff:a.b.c.d): judged by the embedded IPv4.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]!);
    // ULA fc00::/7 (fc.. / fd..) and link-local fe80::/10 (fe8/fe9/fea/feb..).
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    return false;
  }
  return false; // invalid IP: left to the caller's DNS/URL validation, no false judgment here
}

/** IPv4 private/loopback/link-local/unspecified range check. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const a = parts[0]!;
  const b = parts[1]!; // length===4 guaranteed by the guard above
  if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)
  return false;
}

/**
 * Filename sanitization against traversal: strip path separators and parent-dir references, keep a safe
 * basename. Empty falls back to 'file'.
 */
export function sanitizeFilename(name: string): string {
  // Take the last segment (drop any / or \ prefix), then strip remaining illegal chars.
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned : 'file';
}
