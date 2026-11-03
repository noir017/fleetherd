import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRawConfigIfExists, saveConfigPatch } from '../config/load.js';
import { HostDefSchema } from '../config/schema.js';
import { parseDestination } from '../remote/binaries.js';
import { pinnedHostKey, PRIVATE_SOURCES, readKnownHosts } from './pod-peers.js';
import { defaultIdentityFile, defaultKnownHostsFile } from './remote-hosts.js';

/**
 * Adding and removing hosts (pods) from a chat, as an agent would: `talkcode pod-add`, `pod-remove`
 * and the line `talkcode pods` prints for a new host's authorized_keys. Everything a person did by
 * hand on the gateway for a new machine — a `hosts:` entry, a pinned host key, the key the gateway
 * logs in with — in one command whose output says what is left to do on the host.
 *
 * The host key is given, never fetched: the gateway pins keys and does not learn one by itself
 * (remote/binaries.ts sshArgs). Whoever adds the host reads it ON the host, through access of their
 * own, which is the one place it can be trusted from.
 *
 * Hosts added here use the gateway's default key and known_hosts; config.yaml is patched in place
 * (saveConfigPatch keeps its comments), so a host added by an agent reads like one added by hand.
 */

const HOST_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+=*)(?:\s.*)?$/;

/**
 * The line a new host puts in its `~/.ssh/authorized_keys` so this gateway can log in: the gateway's
 * key, `restrict` (no terminal, no forwarding — it runs one command per connection) and, like the
 * mesh keys, only from private addresses. A gateway without a key yet gets one now.
 */
export function gatewayKeyLine(identityFile = defaultIdentityFile()): string {
  if (!fs.existsSync(identityFile)) {
    fs.mkdirSync(path.dirname(identityFile), { recursive: true, mode: 0o700 });
    const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'talkcode-gateway', '-f', identityFile], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`could not make the gateway's ssh key ${identityFile}: ${made.stderr || made.error?.message}`);
  }
  const pub = fs.existsSync(`${identityFile}.pub`)
    ? fs.readFileSync(`${identityFile}.pub`, 'utf8')
    : spawnSync('ssh-keygen', ['-y', '-f', identityFile], { encoding: 'utf8' }).stdout;
  const [type, b64] = pub.trim().split(/\s+/);
  if (!type || !b64) throw new Error(`no public key for ${identityFile}`);
  return `restrict,from="${PRIVATE_SOURCES}" ${type} ${b64} talkcode-gateway`;
}

/** `host` for port 22, `[host]:port` otherwise — how known_hosts names an address. */
function knownHostsName(ssh: string): string {
  const { userHost, port } = parseDestination(ssh);
  const host = userHost.slice(userHost.lastIndexOf('@') + 1);
  return port && port !== 22 ? `[${host}]:${port}` : host;
}

/** Add `hosts.<name>` and pin its host key. Throws a sentence for the agent when it cannot. */
export function addPod(name: string, ssh: string, hostKey: string, knownHostsFile = defaultKnownHostsFile()): void {
  if (!HOST_ID.test(name)) throw new Error(`"${name}" cannot name a host: 1-32 letters, digits, _ or -, starting with a letter or digit`);
  const dest = HostDefSchema.shape.ssh.safeParse(ssh);
  if (!dest.success) throw new Error(`"${ssh}": ${dest.error.issues[0]?.message ?? 'not user@host[:port]'}`);
  const key = HOST_KEY.exec(hostKey.trim());
  if (!key) throw new Error('--host-key must be the host\'s public key line, e.g. the contents of /etc/ssh/ssh_host_ed25519_key.pub on it');
  const pinned = `${key[1]} ${key[2]}`;
  const raw = readRawConfigIfExists() ?? {};
  const hosts = (raw.hosts && typeof raw.hosts === 'object' ? raw.hosts : {}) as Record<string, { ssh?: string }>;
  if (hosts[name]) throw new Error(`host "${name}" already exists (ssh: ${hosts[name].ssh ?? '?'}); \`talkcode pod-remove ${name}\` first to replace it`);
  const text = readKnownHosts(knownHostsFile);
  const already = pinnedHostKey(text, ssh);
  if (already && already !== pinned) {
    throw new Error(`the gateway's known_hosts already pins a different key for ${knownHostsName(ssh)}; if the host really changed its key, remove that host first`);
  }
  if (!already) {
    fs.mkdirSync(path.dirname(knownHostsFile), { recursive: true, mode: 0o700 });
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(knownHostsFile, `${sep}${knownHostsName(ssh)} ${pinned}\n`, { mode: 0o600 });
  }
  saveConfigPatch([{ path: ['hosts', name], value: { ssh } }]);
}

/**
 * Remove `hosts.<name>` and the key pinned for its address (unless another host still uses it).
 * Refused while config.yaml itself still needs the host — agents written for it there, or routing
 * that names one of its agents — since the config would then not load.
 */
export function removePod(name: string, knownHostsFile = defaultKnownHostsFile()): void {
  const raw = readRawConfigIfExists() ?? {};
  const hosts = (raw.hosts && typeof raw.hosts === 'object' ? raw.hosts : {}) as Record<string, { ssh?: string }>;
  const def = hosts[name];
  if (!def) throw new Error(`no host "${name}" (hosts: ${Object.keys(hosts).join(', ') || 'none'})`);
  const agents = (Array.isArray(raw.agents) ? raw.agents : []) as Array<{ id?: string; host?: string }>;
  const own = agents.filter((a) => a.host === name).map((a) => a.id);
  if (own.length) throw new Error(`config.yaml defines agents on "${name}" (${own.join(', ')}); remove them from config.yaml first`);
  const routing = (raw.routing ?? {}) as { default?: string; pipeline?: Array<{ use?: { agent?: string } }> };
  const named = [routing.default, ...(routing.pipeline ?? []).map((r) => r.use?.agent)].filter((id): id is string => !!id?.endsWith(`@${name}`));
  if (named.length) throw new Error(`routing in config.yaml names ${[...new Set(named)].join(', ')}; point it elsewhere first`);
  saveConfigPatch([{ path: ['hosts', name], value: undefined }]);
  const shared = Object.entries(hosts).some(([id, h]) => id !== name && h.ssh && def.ssh && knownHostsName(h.ssh) === knownHostsName(def.ssh));
  if (def.ssh && !shared) {
    const pattern = knownHostsName(def.ssh);
    const text = readKnownHosts(knownHostsFile);
    const kept = text.split('\n').filter((l) => !l.trim().split(/\s+/)[0]?.split(',').includes(pattern));
    if (kept.length !== text.split('\n').length) fs.writeFileSync(knownHostsFile, kept.join('\n'), { mode: 0o600 });
  }
}
