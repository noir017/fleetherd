import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedEndpoint, encryptPayload, fromB64url, vapidToken, WebPush, type PushFetch } from './webpush.js';

/**
 * Web Push (webpush.ts): the encryption against RFC 8291's own Appendix A, the VAPID token against
 * its public key, the endpoint allowlist, and what a gone subscription does.
 */

// RFC 8291 Appendix A (https://www.rfc-editor.org/rfc/rfc8291.txt, read 2026-11-02).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

/** Decrypt a body as the browser would (RFC 8291 from the receiver's side), to round-trip real messages. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const prkKey = h(auth, ecdh.computeSecret(asPublic));
  const ikm = h(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const sealed = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString();
}

describe('encryptPayload', () => {
  it('produces RFC 8291 Appendix A’s body, byte for byte', () => {
    const body = encryptPayload(
      fromB64url(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { asPrivate: fromB64url(RFC.asPrivate), salt: fromB64url(RFC.salt) }
    );
    expect(body.equals(Buffer.concat([fromB64url(RFC.header), fromB64url(RFC.ciphertext)]))).toBe(true);
  });

  it('a fresh message decrypts on the receiving side, and no two are alike', () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const a = encryptPayload(Buffer.from('{"title":"T"}'), keys);
    const b = encryptPayload(Buffer.from('{"title":"T"}'), keys);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, fromB64url(RFC.uaPrivate), fromB64url(RFC.auth))).toBe('{"title":"T"}');
  });

  it('refuses keys that could never be encrypted to', () => {
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: RFC.auth })).toThrow(/P-256/);
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: 'AAAA' })).toThrow(/16 bytes/);
  });
});

describe('allowedEndpoint', () => {
  it('takes the push services browsers use, over HTTPS', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://jmt17.google.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QAbc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(allowedEndpoint(ok), ok).toBe(true);
    }
  });

  it('refuses everything else — this server POSTs to it', () => {
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://jmt17.google.com/search?q=x',
      'https://accounts.google.com/o/oauth2',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'not a url',
    ]) {
      expect(allowedEndpoint(bad), bad).toBe(false);
    }
  });
});

describe('vapidToken', () => {
  it('is an ES256 JWT for the push service’s origin, verifiable with the public key', () => {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-'));
    try {
      const push = new WebPush(dir);
      const priv = (push as unknown as { privateKey: Parameters<typeof vapidToken>[1] }).privateKey;
      const token = vapidToken('https://fcm.googleapis.com', priv, 1_000_000_000_000);
      const [h, c, s] = token.split('.');
      expect(JSON.parse(fromB64url(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
      expect(JSON.parse(fromB64url(c!).toString())).toEqual({
        aud: 'https://fcm.googleapis.com',
        exp: 1_000_000_000 + 12 * 3600,
        sub: 'https://github.com/noir017/fleetherd',
      });
      const pub = createPublicKey({ key: priv as never });
      expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64url(s!))).toBe(true);
      expect(fromB64url(push.publicKey)).toHaveLength(65);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });
});

describe('WebPush', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } });

  it('keeps its key and its devices across a restart, in owner-only files', () => {
    const a = new WebPush(dir);
    a.subscribe(sub(1));
    const b = new WebPush(dir);
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.has(sub(1).endpoint)).toBe(true);
    expect(fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'subscriptions.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses an endpoint that is not a push service', () => {
    const push = new WebPush(dir);
    expect(() => push.subscribe({ ...sub(1), endpoint: 'https://example.com/x' })).toThrow(/push service/);
    expect(push.count).toBe(0);
  });

  it('sends each device a message only it can read, and drops one its service says is gone', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    const fetcher: PushFetch = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return { status: url.endsWith('/2') ? 410 : 201 };
    };
    const push = new WebPush(dir, fetcher);
    push.subscribe(sub(1));
    push.subscribe(sub(2));
    expect((await push.notifyAll({ topic: 'aa', title: 'T', body: 'Finished' })).sort()).toEqual(['gone', 'sent']);
    expect(push.count).toBe(1);
    const first = seen.find((s) => s.url.endsWith('/1'))!;
    expect(first.headers['Content-Encoding']).toBe('aes128gcm');
    expect(first.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(JSON.parse(decrypt(first.body, fromB64url(RFC.uaPrivate), fromB64url(RFC.auth)))).toEqual({
      topic: 'aa',
      title: 'T',
      body: 'Finished',
    });
  });

  it('never throws on a failed send', async () => {
    const push = new WebPush(dir, async () => {
      throw new Error('ECONNRESET');
    });
    push.subscribe(sub(1));
    expect(await push.notifyAll({})).toEqual(['failed']);
    expect(push.count).toBe(1);
  });
});
