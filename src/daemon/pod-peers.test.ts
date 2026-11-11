import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Welcome } from '../remote/connection.js';
import type { PodsState } from '../config/pods.js';
import { leaveMesh, peerFiles, pinnedHostKey, syncPeers, PRIVATE_SOURCES, type Peer } from './pod-peers.js';

/**
 * The pod-to-pod ssh mesh: what each pod gets in ~/.fleetherd/ssh/, where host keys come from (the
 * gateway's own known_hosts), and who gets the files written.
 */

const peers: Peer[] = [
  { id: 'uniagent', key: 'ssh-ed25519 AAAAuni', ssh: 'user@192.0.2.30:22022', hostKey: 'ssh-ed25519 HOSTuni' },
  { id: 'aws', key: 'ssh-ed25519 AAAAaws', ssh: 'user@192.0.2.35:22022', hostKey: 'ssh-ed25519 HOSTaws' },
  { id: 'plain', key: 'ssh-ed25519 AAAAplain', ssh: '10.0.0.9', hostKey: 'ssh-ed25519 HOSTplain' },
];

describe('peerFiles', () => {
  const f = peerFiles('uniagent', peers);

  it('trusts every other pod’s key, from private addresses only, and not its own', () => {
    const lines = f.authorizedKeys.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual([
      `from="${PRIVATE_SOURCES}" ssh-ed25519 AAAAaws fleetherd-peer@aws`,
      `from="${PRIVATE_SOURCES}" ssh-ed25519 AAAAplain fleetherd-peer@plain`,
    ]);
    // Full ssh is the point: no restrict.
    expect(f.authorizedKeys).not.toContain('restrict');
  });

  it('pins the other pods’ host keys under <host>.pod', () => {
    expect(f.knownHosts).toContain('aws.pod ssh-ed25519 HOSTaws\n');
    expect(f.knownHosts).not.toContain('uniagent.pod');
  });

  it('gives each other pod a Host block naming its own HostKeyAlias, then shared defaults', () => {
    expect(f.config).toContain('Host aws.pod\n  HostName 192.0.2.35\n  Port 22022\n  User user\n  HostKeyAlias aws.pod\n');
    expect(f.config).toContain('Host plain.pod\n  HostName 10.0.0.9\n  HostKeyAlias plain.pod\n');
    expect(f.config).not.toContain('Host uniagent.pod');
    const shared = f.config.indexOf('Host *.pod');
    expect(shared).toBeGreaterThan(f.config.lastIndexOf('HostKeyAlias'));
    expect(f.config.slice(shared)).toMatch(/UserKnownHostsFile ~\/\.fleetherd\/ssh\/known_hosts\n[\s\S]*StrictHostKeyChecking yes/);
  });

  it('is empty, header aside, for a pod outside the mesh', () => {
    const empty = peerFiles('x', []);
    expect(empty.authorizedKeys.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([]);
  });
});

describe('pinnedHostKey', () => {
  const text = [
    '# comment',
    '@cert-authority *.example ssh-ed25519 CA',
    'uniagent ssh-ed25519 KEY22',
    '[192.0.2.35]:22022 ssh-ed25519 KEYA',
    'other,[192.0.2.108]:22022 ssh-ed25519 KEYB extra',
    '',
  ].join('\n');

  it.each([
    ['user@uniagent:22', 'ssh-ed25519 KEY22'],
    ['user@uniagent', 'ssh-ed25519 KEY22'],
    ['user@192.0.2.35:22022', 'ssh-ed25519 KEYA'],
    ['user@192.0.2.108:22022', 'ssh-ed25519 KEYB'],
    ['user@192.0.2.35:22023', undefined],
    ['user@example', undefined],
  ])('%s → %s', (dest, key) => {
    expect(pinnedHostKey(text, dest)).toBe(key);
  });
});

describe('syncPeers', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-peers-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  /** A host whose home is `home/<id>`, writing real files. */
  function host(id: string) {
    const h = path.join(home, id);
    fs.mkdirSync(h, { recursive: true });
    return {
      id,
      ready: async (): Promise<Welcome> => ({ home: h, version: 'v', instance: 'i', pid: 1, os: 'linux', arch: 'x64', resumed: false }),
      stat: async (p: string) => ({ exists: fs.existsSync(p) }),
      readFile: async (p: string) => fs.readFileSync(p),
      run: async () => ({ code: 0, output: Buffer.alloc(0) }),
      writeFile: async (p: string, data: Uint8Array, mode?: number) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data, { mode });
      },
    };
  }
  const file = (id: string, name: string): string => fs.readFileSync(path.join(home, id, '.fleetherd/ssh', name), 'utf8');

  const hosts = {
    a: { ssh: 'user@10.0.0.1:2201' },
    b: { ssh: 'user@10.0.0.2:2202' },
    c: { ssh: 'user@10.0.0.3:2203' },
    nokey: { ssh: 'user@10.0.0.4:2204' },
  };
  const known = '[10.0.0.1]:2201 ssh-ed25519 HA\n[10.0.0.2]:2202 ssh-ed25519 HB\n[10.0.0.3]:2203 ssh-ed25519 HC\n';
  const rec = (key?: string, ssh?: string): PodsState[string] => ({ source: 'file', agents: [], at: 't', ...(key ? { peer: { key, ...(ssh ? { ssh } : {}) } } : {}) });

  it('writes each mesh pod the others, vouched for by the gateway’s known_hosts, at the address they declared', async () => {
    const all = Object.fromEntries(['a', 'b', 'c', 'nokey'].map((id) => [id, host(id)]));
    const notes = await syncPeers({
      pods: { a: rec('ssh-ed25519 KA'), b: rec('ssh-ed25519 KB', 'user@10.9.9.9:22'), c: rec(), nokey: rec('ssh-ed25519 KN') },
      hosts,
      reachable: ['a', 'b', 'c', 'nokey'],
      host: (id) => all[id],
      knownHostsText: () => known,
    });
    expect(notes).toEqual([expect.stringMatching(/^nokey: left out .* no plain host key/)]);
    expect(file('a', 'authorized_keys')).toContain('ssh-ed25519 KB fleetherd-peer@b');
    expect(file('a', 'authorized_keys')).not.toContain('KN');
    expect(file('a', 'known_hosts')).toContain('b.pod ssh-ed25519 HB');
    expect(file('a', 'config')).toContain('Host b.pod\n  HostName 10.9.9.9\n  Port 22\n');
    expect(file('b', 'config')).toContain('Host a.pod\n  HostName 10.0.0.1\n  Port 2201\n');
    expect(fs.statSync(path.join(home, 'a', '.fleetherd/ssh/authorized_keys')).mode & 0o777).toBe(0o600);
    // Not in the mesh and never was: nothing written.
    expect(fs.existsSync(path.join(home, 'c', '.fleetherd/ssh'))).toBe(false);
  });

  // 3.0.0 compatibility: a host's files written by talkcode carry `talkcode-peer@<id>` lines, in
  // ~/.talkcode/ssh — after the bootstrap's move, the same files as ~/.fleetherd/ssh.
  it('replaces the talkcode-peer@ lines of a file written before 3.0.0, never adding beside them', async () => {
    const all = { a: host('a'), b: host('b') };
    const ssh = path.join(home, 'a', '.fleetherd', 'ssh');
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(path.join(ssh, 'authorized_keys'), '# Written by the talkcode gateway …\nfrom="10.0.0.0/8" ssh-ed25519 KB talkcode-peer@b\n');
    fs.symlinkSync('.fleetherd', path.join(home, 'a', '.talkcode'));
    await syncPeers({ pods: { a: rec('ssh-ed25519 KA'), b: rec('ssh-ed25519 KB') }, hosts, reachable: ['a', 'b'], host: (id) => all[id as 'a'], knownHostsText: () => known });
    const keys = fs.readFileSync(path.join(home, 'a', '.talkcode', 'ssh', 'authorized_keys'), 'utf8');
    expect(keys).not.toContain('talkcode-peer@');
    expect(keys.match(/ssh-ed25519 KB /g)).toHaveLength(1);
    expect(keys).toContain('ssh-ed25519 KB fleetherd-peer@b');
  });

  it('empties a removed pod’s files on its way out, and says so when it cannot', async () => {
    const all = { a: host('a'), b: host('b') };
    await syncPeers({ pods: { a: rec('ssh-ed25519 KA'), b: rec('ssh-ed25519 KB') }, hosts, reachable: ['a', 'b'], host: (id) => all[id as 'a'], knownHostsText: () => known });
    expect(await leaveMesh(all.b, 1_000)).toBeUndefined();
    expect(file('b', 'authorized_keys')).not.toContain('KA');
    const down = { ...host('z'), ready: () => new Promise<Welcome>(() => {}) };
    expect(await leaveMesh(down, 30)).toMatch(/^z could not be reached .*\(no answer/);
  });

  it('empties the files of a pod that left the mesh, and writes nothing to a pod not reached', async () => {
    const all = { a: host('a'), b: host('b') };
    await syncPeers({ pods: { a: rec('ssh-ed25519 KA'), b: rec('ssh-ed25519 KB') }, hosts, reachable: ['a', 'b'], host: (id) => all[id as 'a'], knownHostsText: () => known });
    expect(file('a', 'authorized_keys')).toContain('KB');
    await syncPeers({ pods: { a: rec(), b: rec('ssh-ed25519 KB') }, hosts, reachable: ['a'], host: (id) => all[id as 'a'], knownHostsText: () => known });
    expect(file('a', 'authorized_keys')).not.toContain('KB');
    expect(file('a', 'config')).not.toContain('Host b.pod');
    // b was not reached this time, so it still has a's key from before — until the next pass reaches it.
    expect(file('b', 'authorized_keys')).toContain('KA');
  });
});
