import { createECDH, createHmac, createCipheriv, generateKeyPairSync, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Web Push, server half: the VAPID key, the devices that asked to be notified, and the encrypted
 * POST to each device's push service. What lets the web UI reach a phone whose page is closed.
 *
 * ── Why the page alone cannot ──────────────────────────────────────────────────────────────────
 * A phone freezes a page the moment it is put down, so the event stream drops and nothing the
 * daemon sends arrives (room.ts `TranscriptStore` has the 2026-10-31 report). Only a push service —
 * Google's for Chrome on Android, Apple's for an installed app on iOS, Mozilla's for Firefox —
 * reaches a device then, and it wakes the page's service worker (page.ts `SERVICE_WORKER`), which
 * shows the notification. Android Chrome does not even let a page construct a `Notification`
 * itself; it has to come from a service worker.
 *
 * ── No dependency, on purpose ──────────────────────────────────────────────────────────────────
 * The whole protocol is two RFCs over primitives `node:crypto` has: RFC 8291 (message encryption,
 * `aes128gcm` from RFC 8188) and RFC 8292 (VAPID: an ES256 JWT naming this server). The npm
 * `web-push` package would add its own dependency tree to a gateway that holds the operator's
 * credentials, for roughly the hundred lines below — which are checked against RFC 8291's own
 * Appendix A vectors in webpush.test.ts.
 *
 * ── What the push service sees ──────────────────────────────────────────────────────────────────
 * The payload is encrypted to the device's key (RFC 8291), so Google or Apple carries ciphertext:
 * they learn that this server notified that device, when, and roughly how much, not what. The
 * payload is the topic's name and one line about it, never a transcript.
 *
 * ── Where a notification may be sent ──────────────────────────────────────────────────────────
 * A subscription's endpoint is a URL the BROWSER chose, delivered to this server in a request body,
 * which this server then POSTs to. Left open, that is a way to make the gateway send requests
 * anywhere (security invariant 3 is the same concern for attachments). So an endpoint must be HTTPS
 * on one of the push services browsers actually use (PUSH_HOSTS) — anything else is refused at
 * subscribe time, and checked again before every send.
 */

/**
 * The push services the major browsers use: a host suffix, and where one is needed a path prefix
 * that keeps a broad suffix to the push service alone (checked 2026-11-02).
 */
const PUSH_SERVICES: ReadonlyArray<{ host: string; path?: string }> = [
  { host: 'fcm.googleapis.com' }, // Chrome, Edge (Chromium), Opera, Samsung Internet
  // Chromium itself — unbranded builds, Playwright's included — subscribes at jmt17.google.com/fcm/send/…,
  // found the hard way: the first real subscription in a test browser was refused. Held to /fcm/ so
  // the rest of google.com stays out.
  { host: 'google.com', path: '/fcm/' },
  { host: 'push.services.mozilla.com' }, // Firefox (updates.push.services.mozilla.com)
  { host: 'push.apple.com' }, // Safari and installed iOS apps (web.push.apple.com)
  { host: 'notify.windows.com' }, // legacy Edge (wns2-*.notify.windows.com)
];

/** How many devices may be subscribed. A person has a few; a runaway page should not fill a file. */
const MAX_SUBSCRIPTIONS = 20;

/** How long a push service keeps an undelivered message (s). A notification a day late is still news. */
const TTL_SECONDS = 24 * 3600;

/** The `sub` claim RFC 8292 asks for: a contact for the push service. The project, not a person. */
const VAPID_SUBJECT = 'https://github.com/noir017/fleetherd';

/** One device's subscription, as `PushSubscription.toJSON()` gives it. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Whether an endpoint is one this server will send to. */
export function allowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICES.some((s) => (host === s.host || host.endsWith(`.${s.host}`)) && (!s.path || url.pathname.startsWith(s.path)));
}

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/**
 * Encrypt one message for one device: RFC 8291 §3.4 over RFC 8188's `aes128gcm`, one record.
 *
 * `ephemeral` and `salt` are for the RFC's test vectors only; a real message gets fresh ones, and
 * reusing either with the same device key would let an observer correlate messages.
 */
export function encryptPayload(
  plaintext: Buffer,
  keys: { p256dh: string; auth: string },
  test?: { asPrivate: Buffer; salt: Buffer }
): Buffer {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('subscription key p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('subscription auth secret is not 16 bytes');

  const ecdh = createECDH('prime256v1');
  if (test) ecdh.setPrivateKey(test.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = test?.salt ?? randomBytes(16);

  // RFC 8291 §3.3–3.4: the auth secret and both public keys go into the key, so a message can only
  // be read by the browser that made this subscription.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // One record, so the padding delimiter is 0x02 (last record) and no padding follows it.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 §2.1 header: salt, record size (4096), key id length, key id (the sender's public key).
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 §2: an ES256 JWT for the push service at `audience` (its origin), valid twelve hours. */
export function vapidToken(audience: string, privateKey: KeyObject, now = Date.now()): string {
  const enc = (o: unknown): string => b64url(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT })}`;
  // JOSE wants r||s, not DER — `ieee-p1363` is exactly that.
  const sig = sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64url(sig)}`;
}

/** What a push service answered, for the log and for dropping dead subscriptions. */
export type PushResult = 'sent' | 'gone' | 'failed';

/** The fetch this module uses; injected so tests run without a network. */
export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

/**
 * The VAPID key pair and the subscriptions, both kept in one directory (0700) as 0600 files, beside
 * the web UI's other per-instance state.
 *
 * The key is made once and kept: every subscription a browser made names it (as its
 * `applicationServerKey`), so a new key would orphan every device until each subscribed again.
 */
export class WebPush {
  private readonly privateKey: KeyObject;
  /** The public key, uncompressed point, base64url — what the page hands `pushManager.subscribe`. */
  readonly publicKey: string;
  private subs: PushSubscriptionRecord[] = [];

  constructor(
    private readonly dir: string,
    private readonly fetcher: PushFetch = (url, init) => fetch(url, { ...init, body: new Uint8Array(init.body) })
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(dir, 'vapid.json');
    let jwk: { kty: string; crv: string; x: string; y: string; d: string } | undefined;
    try {
      jwk = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as typeof jwk;
    } catch {
      jwk = undefined;
    }
    if (!jwk?.d) {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      jwk = pair.privateKey.export({ format: 'jwk' }) as typeof jwk;
      fs.writeFileSync(keyFile, JSON.stringify(jwk), { mode: 0o600 });
      console.log(`[webui] made a Web Push key in ${keyFile}`);
    }
    this.privateKey = createPrivateKey({ key: jwk as never, format: 'jwk' });
    this.publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk!.x), fromB64url(jwk!.y)]));
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'subscriptions.json'), 'utf8'));
      this.subs = Array.isArray(raw) ? raw.filter(isRecord) : [];
    } catch {
      this.subs = [];
    }
  }

  /** How many devices are subscribed. */
  get count(): number {
    return this.subs.length;
  }

  /** Remember a device. Refuses an endpoint that is not a known push service (see allowedEndpoint). */
  subscribe(sub: PushSubscriptionRecord): void {
    if (!allowedEndpoint(sub.endpoint)) throw new Error('that is not the endpoint of a push service a browser uses');
    encryptPayload(Buffer.from('probe'), sub.keys); // throws on keys that could never be encrypted to
    this.subs = [sub, ...this.subs.filter((s) => s.endpoint !== sub.endpoint)].slice(0, MAX_SUBSCRIPTIONS);
    this.save();
  }

  /** Forget a device. */
  unsubscribe(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  /** Whether a device is subscribed (the page asks, to label its button). */
  has(endpoint: string): boolean {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  /**
   * Notify every subscribed device. Never throws: a notification is decoration on a turn that has
   * already happened. A subscription the push service says is gone (404, 410) is dropped.
   */
  async notifyAll(payload: unknown): Promise<PushResult[]> {
    const body = Buffer.from(JSON.stringify(payload));
    const results = await Promise.all(this.subs.map((s) => this.send(s, body)));
    const gone = this.subs.filter((_, i) => results[i] === 'gone');
    if (gone.length) {
      for (const g of gone) this.unsubscribe(g.endpoint);
      console.log(`[webui] dropped ${gone.length} push subscription(s) their service no longer has`);
    }
    return results;
  }

  private async send(sub: PushSubscriptionRecord, plaintext: Buffer): Promise<PushResult> {
    if (!allowedEndpoint(sub.endpoint)) return 'gone';
    try {
      const origin = new URL(sub.endpoint).origin;
      const res = await this.fetcher(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL_SECONDS),
          Urgency: 'high',
          Authorization: `vapid t=${vapidToken(origin, this.privateKey)}, k=${this.publicKey}`,
        },
        body: encryptPayload(plaintext, sub.keys),
      });
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status >= 200 && res.status < 300) return 'sent';
      console.warn(`[webui] push to ${new URL(sub.endpoint).host} answered ${res.status}`);
      return 'failed';
    } catch (e) {
      console.warn(`[webui] push to ${hostOf(sub.endpoint)} failed:`, e instanceof Error ? e.message : e);
      return 'failed';
    }
  }

  private save(): void {
    try {
      const file = path.join(this.dir, 'subscriptions.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.subs), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.warn('[webui] could not save the push subscriptions:', e instanceof Error ? e.message : e);
    }
  }
}

function isRecord(v: unknown): v is PushSubscriptionRecord {
  const s = v as PushSubscriptionRecord;
  return Boolean(s && typeof s.endpoint === 'string' && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string');
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '?';
  }
}
