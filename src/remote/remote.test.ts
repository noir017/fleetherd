import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostConnection } from './connection.js';
import { FrameDecoder, encodeFrame } from './frame.js';
import { ReliableLink } from './link.js';
import { parseDestination, sshArgs } from './binaries.js';

describe('frame', () => {
  it('round-trips headers and raw bodies, across arbitrary chunk boundaries', () => {
    const a = encodeFrame({ t: 'out', s: 1, id: 'p1', fd: 2 }, Buffer.from('héllo\0'));
    const b = encodeFrame({ t: 'ping', n: 3 });
    const all = Buffer.concat([a, b]);
    const dec = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < all.length; i += 3) frames.push(...dec.push(all.subarray(i, i + 3)));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.h).toEqual({ t: 'out', s: 1, id: 'p1', fd: 2 });
    expect(frames[0]!.body.toString()).toBe('héllo\0');
    expect(frames[1]!.h).toEqual({ t: 'ping', n: 3 });
    expect(frames[1]!.body.length).toBe(0);
    expect(dec.pending).toBe(0);
  });

  it('rejects a zero-length or oversized header', () => {
    expect(() => new FrameDecoder().push(Buffer.alloc(8))).toThrow(/malformed/);
    const big = Buffer.alloc(8);
    big.writeUInt32BE(0xffffffff, 0);
    expect(() => new FrameDecoder().push(big)).toThrow(/malformed/);
  });
});

describe('ReliableLink', () => {
  const written = (): { bufs: Buffer[]; write(b: Buffer): void } => {
    const bufs: Buffer[] = [];
    return { bufs, write: (b) => bufs.push(b) };
  };
  const types = (bufs: Buffer[]): string[] =>
    new FrameDecoder().push(Buffer.concat(bufs)).map((f) => `${f.h.t}${f.h.s ? `#${f.h.s}` : ''}`);

  it('queues while disconnected and resends exactly what the peer has not seen', () => {
    const link = new ReliableLink();
    link.send({ t: 'stdin', id: 'p1' }, Buffer.from('a'));
    link.send({ t: 'stdin', id: 'p1' }, Buffer.from('b'));
    link.send({ t: 'signal', id: 'p1', sig: 'SIGINT' });
    const t = written();
    link.attach(t, 1);
    expect(types(t.bufs)).toEqual(['stdin#2', 'signal#3']);
    expect(link.backlogBytes).toBeGreaterThan(0);
    link.receive({ t: 'ack', a: 3 }, 0);
    expect(link.backlogBytes).toBe(0);
  });

  it('delivers in order, drops duplicates, and refuses a gap', () => {
    const link = new ReliableLink();
    expect(link.receive({ t: 'out', s: 1 }, 0)).toBe(true);
    expect(link.receive({ t: 'out', s: 1 }, 0)).toBe(false);
    expect(link.receive({ t: 'pong', n: 1 }, 0)).toBe(false);
    expect(() => link.receive({ t: 'out', s: 3 }, 0)).toThrow(/gap/);
    expect(link.recvSeq).toBe(1);
  });

  it('acknowledges promptly once enough has arrived', () => {
    const link = new ReliableLink();
    const t = written();
    link.attach(t, 0);
    link.receive({ t: 'out', s: 1 }, 70 << 10);
    expect(types(t.bufs)).toEqual(['ack']);
  });

  it('remembers whether anything was ever exchanged, and forgets on reset', () => {
    const link = new ReliableLink();
    expect(link.hasState).toBe(false);
    link.send({ t: 'spawn', id: 'p1' });
    expect(link.hasState).toBe(true);
    link.reset();
    expect(link.hasState).toBe(false);
    expect(link.backlogBytes).toBe(0);
  });
});

describe('ssh', () => {
  it('parses destinations', () => {
    expect(parseDestination('user@host')).toEqual({ userHost: 'user@host', port: undefined });
    expect(parseDestination('user@host:2222')).toEqual({ userHost: 'user@host', port: 2222 });
    expect(parseDestination('[fe80::1]:22')).toEqual({ userHost: 'fe80::1', port: 22 });
    expect(parseDestination('me@[fe80::1]')).toEqual({ userHost: 'me@fe80::1', port: undefined });
  });

  it('pins the key, the known hosts and strict checking, and reads no ssh config', () => {
    const args = sshArgs({ destination: 'u@h:2200', identityFile: '/k', knownHostsFile: '/kh' }, 'echo hi');
    expect(args.slice(0, 2)).toEqual(['-F', 'none']);
    expect(args).toContain('StrictHostKeyChecking=yes');
    // Pins the host KEY: a host certificate would otherwise be negotiated first (see sshArgs).
    expect(args).toContain('HostKeyAlgorithms=-*-cert-v01@openssh.com');
    expect(args).toContain('IdentityFile=/k');
    expect(args).toContain('UserKnownHostsFile=/kh');
    expect(args.slice(-5)).toEqual(['-p', '2200', '--', 'u@h', `sh -c 'echo hi'`]);
  });
});

// 3.0.0 compatibility (legacy-name.ts): the bootstrap moves a host's ~/.talkcode to ~/.fleetherd
// before anything else, leaving a link at the old name. Run as the host runs it, with `sh` and a
// throwaway HOME — never this machine's, which is a live host of a talkcode gateway.
describe('the bootstrap on a host set up before 3.0.0', () => {
  const script = new HostConnection({ hostId: 'h', ns: 'ns', transport: () => { throw new Error('unused'); }, binary: () => undefined }, 'e').bootstrapScript();
  const run = (home: string): string => {
    const r = spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
    return r.stdout;
  };
  const withHome = (f: (home: string) => void): void => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-boot-'));
    try {
      f(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('moves ~/.talkcode to ~/.fleetherd and links the old name to it, once', () => {
    withHome((home) => {
      fs.mkdirSync(path.join(home, '.talkcode', 'ssh'), { recursive: true });
      fs.writeFileSync(path.join(home, '.talkcode', 'pod.yaml'), 'agents: []\n');
      expect(run(home)).toMatch(/^TCR-MOVED ~\/\.talkcode to ~\/\.fleetherd/m);
      expect(fs.lstatSync(path.join(home, '.fleetherd')).isDirectory()).toBe(true);
      expect(fs.readlinkSync(path.join(home, '.talkcode'))).toBe('.fleetherd');
      expect(fs.readFileSync(path.join(home, '.talkcode', 'pod.yaml'), 'utf8')).toBe('agents: []\n');
      // The next connection finds the link and says nothing about it.
      expect(run(home)).not.toMatch(/TCR-MOVED/);
    });
  });

  it('leaves a host alone that has ~/.fleetherd already, or never had ~/.talkcode', () => {
    withHome((home) => {
      expect(run(home)).not.toMatch(/TCR-MOVED/);
      expect(fs.existsSync(path.join(home, '.fleetherd'))).toBe(false);
      fs.mkdirSync(path.join(home, '.talkcode'));
      fs.mkdirSync(path.join(home, '.fleetherd'));
      expect(run(home)).not.toMatch(/TCR-MOVED/);
      expect(fs.lstatSync(path.join(home, '.talkcode')).isDirectory()).toBe(true);
    });
  });
});
