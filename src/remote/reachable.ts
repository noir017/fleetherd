import net from 'node:net';
import { parseDestination } from './binaries.js';

/**
 * Whether a TCP connection to a host's ssh port opens within `timeoutMs` — no ssh, no login, the
 * socket is closed the moment it connects. What daemon/host-availability.ts asks every minute to
 * tell a machine that is asleep or off the network from one that is merely idle: a laptop under
 * WSL2 that went to sleep answers nothing at all (laptop, 2026-11-09), and a probe that waited on
 * ssh's own ConnectTimeout (15 s, sshArgs) would hold a check that long for every such host.
 * Eight seconds allows for up to two Linux TCP SYN retransmissions (RTO 1s + 2s + RTT) across
 * lossy cross-border VPN links (e.g. EasyTier to a laptop on Wi-Fi, 2026-11-11) while still
 * failing well before ssh's 15s timeout.
 *
 * A port that answers is not proof that ssh will work — a wrong key or a changed host key still
 * fails the connection — and that is deliberate: the question here is "is it there", and those
 * failures are already reported where a connection is attempted, with their reason.
 */
export function canReach(destination: string, timeoutMs = 8_000): Promise<boolean> {
  const { userHost, port } = parseDestination(destination);
  const host = userHost.slice(userHost.lastIndexOf('@') + 1);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: port ?? 22 });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
