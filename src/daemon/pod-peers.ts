import fs from 'node:fs';
import type { HostDef } from '../config/schema.js';
import type { PodsState } from '../config/pods.js';
import { parseDestination } from '../remote/binaries.js';
import { PEER_DIR, type PodHost } from './pods.js';

/**
 * Pod-to-pod ssh (`peer:` in a pod's pod.yaml): every pod in the mesh can `ssh <host>.pod` — and
 * scp, rsync, git, -L/-R — to every other, directly, as plain OpenSSH. The gateway carries none of
 * the traffic. All it does is what each pair of pods used to need done by hand: on every pod in the
 * mesh it writes `~/.talkcode/ssh/`
 *
 *   authorized_keys   the other pods' mesh keys
 *   known_hosts       their host keys, under `<host>.pod`
 *   config            a `Host <host>.pod` block for each, and the settings they share
 *
 * beside the pod's own key (`id_ed25519`, made on the pod by pods.ts — the private half never
 * leaves it). Rewritten on every read of the pods (startup, `/reload`), so a pod that joins, leaves
 * or moves is known to the others at the next reload.
 *
 * For sshd and ssh to use those files, the pod's sshd has `AuthorizedKeysFile` include
 * `.talkcode/ssh/authorized_keys` and its ssh config includes `~/.talkcode/ssh/config`; the uniagent
 * image ships both. Nothing here touches `~/.ssh`.
 *
 * ── Why the host keys are the gateway's ────────────────────────────────────────────────────────
 * A pod's host key is taken from the gateway's own known_hosts — the key every gateway connection to
 * it is already checked against — not read from the network. So a pod in the mesh is exactly as sure
 * of another pod's identity as the gateway is, and never learns a key by itself.
 *
 * ── Who may log in ─────────────────────────────────────────────────────────────────────────────
 * A mesh key works only from private addresses (`from=`, PRIVATE_SOURCES): the pods talk over the
 * mesh or a container network, and the exact source differs per path (a published port, NAT into a
 * tunnel, a hairpin on one host) where a per-pair address was what kept breaking. No `restrict`: the
 * point is full ssh, terminals and forwarding included.
 */

/** Where a mesh key may log in from: every private range, none of the internet. */
export const PRIVATE_SOURCES = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1';

/** The name a pod has in the mesh. */
export function peerName(host: string): string {
  return `${host}.pod`;
}

/** One pod as the others see it. */
export interface Peer {
  id: string;
  /** Its mesh public key, `<type> <base64>`. */
  key: string;
  /** How the others reach it: `user@host[:port]`. */
  ssh: string;
  /** Its host key, `<type> <base64>`. */
  hostKey: string;
}

const HEADER = '# Written by the talkcode gateway for the pod-to-pod ssh mesh (peer: in ~/.talkcode/pod.yaml).\n# Rewritten on every gateway start and /reload — edit pod.yaml, not this.\n';

/** The three files for pod `self`, from every pod in the mesh (`self` included or not). */
export function peerFiles(self: string, peers: readonly Peer[]): { authorizedKeys: string; knownHosts: string; config: string } {
  const others = peers.filter((p) => p.id !== self);
  const authorizedKeys = others.map((p) => `from="${PRIVATE_SOURCES}" ${p.key} talkcode-peer@${p.id}\n`).join('');
  const knownHosts = others.map((p) => `${peerName(p.id)} ${p.hostKey}\n`).join('');
  const blocks = others.map((p) => {
    const { userHost, port } = parseDestination(p.ssh);
    const at = userHost.lastIndexOf('@');
    return [
      `Host ${peerName(p.id)}`,
      `  HostName ${at < 0 ? userHost : userHost.slice(at + 1)}`,
      ...(port ? [`  Port ${port}`] : []),
      ...(at < 0 ? [] : [`  User ${userHost.slice(0, at)}`]),
      // Not %n: HostKeyAlias takes no tokens, so each block names itself.
      `  HostKeyAlias ${peerName(p.id)}`,
      '',
    ].join('\n');
  });
  // After the blocks: ssh takes the first value it finds for each option, so these are defaults.
  const shared = [
    'Host *.pod',
    '  IdentityFile ~/.talkcode/ssh/id_ed25519',
    '  IdentitiesOnly yes',
    '  UserKnownHostsFile ~/.talkcode/ssh/known_hosts',
    '  StrictHostKeyChecking yes',
    // The pinned key is a plain host key; a host that also presents a certificate (a Teleport node)
    // would otherwise be checked by the certificate's key (see remote/binaries.ts sshArgs).
    '  HostKeyAlgorithms -*-cert-v01@openssh.com',
    '  ServerAliveInterval 15',
    '',
  ].join('\n');
  return { authorizedKeys: HEADER + authorizedKeys, knownHosts: HEADER + knownHosts, config: `${HEADER}\n${blocks.join('\n')}\n${shared}` };
}

/**
 * The host key the gateway pins for `destination` in a known_hosts text, as `<type> <base64>` — the
 * line `ssh-keyscan` / ssh write: `host` for port 22, `[host]:port` otherwise. Hashed entries are
 * not read (the gateway's file is written plain, by hand or by pod-admin.ts).
 */
export function pinnedHostKey(knownHosts: string, destination: string): string | undefined {
  const { userHost, port } = parseDestination(destination);
  const host = userHost.slice(userHost.lastIndexOf('@') + 1);
  const pattern = port && port !== 22 ? `[${host}]:${port}` : host;
  for (const line of knownHosts.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[0]!.startsWith('#') || f[0]!.startsWith('@')) continue;
    if (f[0]!.split(',').includes(pattern)) return `${f[1]} ${f[2]}`;
  }
  return undefined;
}

/**
 * Write the mesh files to every pod read just now (`reachable`). A pod in the mesh gets all three; a
 * pod that left it gets them emptied, so it stops trusting the others too. A pod without a pinned
 * host key cannot be vouched for, so it is left out of the others' files, and said so.
 */
export async function syncPeers(opts: {
  pods: PodsState;
  hosts: Record<string, HostDef>;
  reachable: readonly string[];
  host(id: string): (PodHost & { writeFile(path: string, data: Uint8Array, mode?: number): Promise<void> }) | undefined;
  knownHostsText(def: HostDef): string;
}): Promise<string[]> {
  const notes: string[] = [];
  const peers: Peer[] = [];
  for (const [id, def] of Object.entries(opts.hosts)) {
    const peer = opts.pods[id]?.peer;
    if (!peer) continue;
    const hostKey = pinnedHostKey(opts.knownHostsText(def), def.ssh);
    if (!hostKey) {
      notes.push(`${id}: left out of the pod-to-pod ssh mesh — no plain host key for ${def.ssh} in the gateway's known_hosts`);
      continue;
    }
    peers.push({ id, key: peer.key, ssh: peer.ssh ?? def.ssh, hostKey });
  }
  await Promise.all(
    opts.reachable.map(async (id) => {
      const host = opts.host(id);
      if (!host) return;
      try {
        const w = await host.ready();
        const dir = `${w.home}/${PEER_DIR}`;
        const inMesh = peers.some((p) => p.id === id);
        if (!inMesh && !(await host.stat(`${dir}/config`)).exists) return;
        const files = inMesh ? peerFiles(id, peers) : peerFiles(id, []);
        await host.writeFile(`${dir}/authorized_keys`, Buffer.from(files.authorizedKeys), 0o600);
        await host.writeFile(`${dir}/known_hosts`, Buffer.from(files.knownHosts), 0o644);
        await host.writeFile(`${dir}/config`, Buffer.from(files.config), 0o644);
      } catch (e) {
        notes.push(`${id}: pod-to-pod ssh files not written (${e instanceof Error ? e.message : String(e)})`);
      }
    })
  );
  return notes;
}

/**
 * Take a host out of the mesh on its way out of the gateway (`pod-remove`): empty its files while it
 * can still be reached, so it stops trusting the others too — after the removal the gateway never
 * reaches it again, and the next pass only drops it from the others' files. Best-effort and bounded:
 * a host that is down keeps its files, and the answer says so.
 */
export async function leaveMesh(host: PodHost & { writeFile(path: string, data: Uint8Array, mode?: number): Promise<void> }, timeoutMs: number): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        const dir = `${(await host.ready()).home}/${PEER_DIR}`;
        if (!(await host.stat(`${dir}/config`)).exists) return;
        const files = peerFiles(host.id, []);
        await host.writeFile(`${dir}/authorized_keys`, Buffer.from(files.authorizedKeys), 0o600);
        await host.writeFile(`${dir}/known_hosts`, Buffer.from(files.knownHosts), 0o644);
        await host.writeFile(`${dir}/config`, Buffer.from(files.config), 0o644);
      })(),
      deadline,
    ]);
    return undefined;
  } catch (e) {
    return `${host.id} could not be reached to empty its ~/${PEER_DIR} files (${e instanceof Error ? e.message : String(e)}); other pods' keys may still be in its authorized_keys there`;
  } finally {
    clearTimeout(timer);
  }
}

/** A known_hosts file's text, or nothing when there is none yet. */
export function readKnownHosts(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
