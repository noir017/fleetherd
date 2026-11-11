/**
 * End-to-end check of the SSO door against a REAL provider over a REAL socket.
 *
 * The unit tests inject `fetch`, so the one thing they cannot see is the actual network hop to
 * the JWKS endpoint (and the timeout/abort plumbing around it). Everything here is the shipped
 * code path: config schema → createWebuiAdapter → node:http server → WebSso.
 *
 * Run: FLEETHERD_CONFIG_DIR=$(mktemp -d) npx tsx scripts/verify-sso.mts
 */
import { createServer } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { WebuiConfigSchema } from '../src/platform/config-schemas.js';
import { createWebuiAdapter } from '../src/platform/webui/index.js';

const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

// A real JWKS server on a real port.
const jwks = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({ keys: [{ ...provider.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })
  );
});
await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
const jwksPort = (jwks.address() as AddressInfo).port;
const jwksUrl = `http://127.0.0.1:${jwksPort}/certs`;

function token(claims: Record<string, unknown> = {}): string {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64({
    iss: 'https://idp.local',
    aud: 'aa-webui',
    email: 'me@example.com',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(provider.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const port = 8899;
const instance = {
  ...WebuiConfigSchema.parse({
    type: 'webui',
    token: 'the-old-door',
    host: '127.0.0.1',
    port,
    sso: {
      jwksUrl,
      issuer: 'https://idp.local',
      audience: 'aa-webui',
      allow: ['ME@example.com'],
      from: ['127.0.0.1'],
      password: false,
    },
  }),
  id: 'verify',
};

const adapter = createWebuiAdapter(instance);
adapter.onMessage(async () => {});
adapter.onButton(async () => {});
adapter.onCommand(async () => {});
await adapter.start();

const base = `http://127.0.0.1:${port}`;
const results: Array<[string, boolean, string]> = [];
const check = (what: string, ok: boolean, detail = ''): void => {
  results.push([what, ok, detail]);
};

// 1. Nothing at all: refused.
check('no assertion → 401', (await fetch(`${base}/api/events`)).status === 401);

// 2. A real signed assertion, verified against keys fetched over the wire.
const withToken = await fetch(`${base}/api/events`, { headers: { 'cf-access-jwt-assertion': token() } });
check('signed assertion → 200 event stream', withToken.status === 200, `got ${withToken.status}`);
await withToken.body?.cancel();

// 3. Someone else, correctly signed by the same provider.
const stranger = await fetch(`${base}/api/events`, {
  headers: { 'cf-access-jwt-assertion': token({ email: 'stranger@example.com' }) },
});
check('another identity → 401', stranger.status === 401, `got ${stranger.status}`);

// 4. A token for a different application of the same issuer.
const otherApp = await fetch(`${base}/api/events`, {
  headers: { 'cf-access-jwt-assertion': token({ aud: 'some-other-app' }) },
});
check('another audience → 401', otherApp.status === 401, `got ${otherApp.status}`);

// 5. The password door, closed by config.
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'the-old-door' }),
});
check('password login → 403 when disabled', login.status === 403, `got ${login.status}`);

// 6. The page served under SSO has no password field.
const page = await (await fetch(base)).text();
check('page has no token field', !page.includes('id="secret"'));

// 7. A message actually gets through the new door.
const topics = await fetch(`${base}/api/topics`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token(), origin: base },
  body: JSON.stringify({ title: 'verify' }),
});
check('POST through the sso door → 2xx', topics.status < 300, `got ${topics.status}`);

for (const [what, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
await adapter.stop();
jwks.close();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
