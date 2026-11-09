import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { canReach } from './reachable.js';

describe('canReach', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listening(): Promise<number> {
    const server = net.createServer((socket) => socket.destroy());
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return (server.address() as net.AddressInfo).port;
  }

  it('answers true for a port that accepts, whatever the user part says', async () => {
    const port = await listening();
    expect(await canReach(`someone@127.0.0.1:${port}`)).toBe(true);
    expect(await canReach(`127.0.0.1:${port}`)).toBe(true);
  });

  it('answers false, without throwing, for a port nothing listens on', async () => {
    const port = await listening();
    await new Promise((r) => servers.pop()!.close(r));
    expect(await canReach(`user@127.0.0.1:${port}`)).toBe(false);
  });

  it('answers false for a name that does not resolve', async () => {
    expect(await canReach('user@no-such-host.invalid:22', 2_000)).toBe(false);
  });
});
