import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { remoteBinary } from './binaries.js';
import type { RemoteArch, Transport } from './connection.js';
import { RemoteHost, type CliBridge, type RemoteChild } from './host.js';

/**
 * The gateway side against the real talkcode-remote binary, end to end — the contract test for the
 * protocol both sides implement (remote/README.md). The "host" is a local `sh` with a HOME of its
 * own: what ssh would run on a remote machine runs here instead, so nothing but ssh itself is
 * stubbed. Builds the binary with the Go toolchain once; skipped where there is none.
 */

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const nativeArch: RemoteArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
let work = '';
let binDir = '';

beforeAll(() => {
  if (!hasGo) return;
  work = mkdtempSync(join(tmpdir(), 'tcr-it-'));
  binDir = join(work, 'bin');
  mkdirSync(binDir);
  execFileSync('go', ['build', '-o', join(binDir, `talkcode-remote-linux-${nativeArch}`), '.'], {
    cwd: new URL('../../remote', import.meta.url).pathname,
    env: { ...process.env, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
}, 120_000);

afterAll(() => {
  if (!work) return;
  // The daemons outlive their connections by design; stop the ones these tests started.
  const pidFiles = execFileSync('sh', ['-c', `ls ${work}/home-*/.talkcode/remote/run/*/daemon.pid 2>/dev/null || true`]);
  for (const file of pidFiles.toString().split('\n').filter(Boolean)) {
    try {
      process.kill(Number(readFileSync(file, 'utf8').trim()), 'SIGTERM');
    } catch {
      // already gone
    }
  }
  rmSync(work, { recursive: true, force: true });
});

const transports: ChildProcess[] = [];
const hosts: RemoteHost[] = [];

afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  for (const p of transports.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
});

function newHome(): string {
  const home = join(work, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home);
  return home;
}

/** A transport that runs the host-side script locally, as ssh would remotely. */
function localTransport(home: string): Transport {
  return (script) => {
    const p = spawn('sh', ['-c', script], {
      env: { ...process.env, HOME: home, SHELL: '/bin/sh' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    transports.push(p);
    return p;
  };
}

function makeHost(home: string, opts: { epoch?: string; version?: string; cli?: CliBridge; ns?: string } = {}): RemoteHost {
  const host = new RemoteHost({
    id: 'testhost',
    ns: opts.ns ?? 'gw1',
    epoch: opts.epoch ?? 'E1',
    transport: localTransport(home),
    binary: (arch) => {
      const b = remoteBinary(arch, 'test', binDir);
      return b && opts.version ? { ...b, version: opts.version } : b;
    },
    cli: opts.cli,
  });
  hosts.push(host);
  return host;
}

function collect(child: RemoteChild): Promise<{ out: string; code: number | null; signal: string | null }> {
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  return new Promise((resolve) => child.on('exit', (code, signal) => setTimeout(() => resolve({ out, code, signal }), 20)));
}

function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
};

describe.skipIf(!hasGo)('talkcode-remote, end to end', () => {
  it('installs itself on first contact, then runs an agent over stdio', async () => {
    const home = newHome();
    const host = makeHost(home);
    const child = host.spawn('cat', [], { cwd: '~' });
    const done = collect(child);
    child.stdin.write('hello\n');
    child.stdin.end();
    const r = await done;
    expect(r).toEqual({ out: 'hello\n', code: 0, signal: null });
    const w = await host.ready();
    expect(w.home).toBe(home);
    expect(existsSync(join(home, '.talkcode/remote', w.version, 'talkcode-remote'))).toBe(true);
    expect(existsSync(join(home, '.talkcode/remote', w.version, 'bin/talkcode'))).toBe(true);
  }, 30_000);

  it('gives the agent its env on top of the login environment, and the shim first on PATH', async () => {
    const home = newHome();
    const host = makeHost(home);
    const child = host.spawn('sh', ['-c', 'echo "$FOO|$PATH|$TALKCODE_REMOTE_SOCK"'], { env: { FOO: 'bar', SKIP: undefined } });
    const { out } = await collect(child);
    const [foo, path, sock] = out.trim().split('|');
    const w = await host.ready();
    expect(foo).toBe('bar');
    expect(path!.startsWith(host.paths(w).binDir + ':')).toBe(true);
    expect(sock).toBe(host.paths(w).socket);
  }, 30_000);

  it('reports a command that does not exist as error + exit, like a local ENOENT', async () => {
    const host = makeHost(newHome());
    const child = host.spawn('no-such-command-xyz', []);
    const err = new Promise<Error>((resolve) => child.on('error', resolve));
    const r = await collect(child);
    expect((await err).message).toMatch(/not found/);
    expect(r.code).not.toBe(0);
  }, 30_000);

  it('fails fast with the reason when a host has never been reachable', async () => {
    const host = new RemoteHost({
      id: 'nowhere',
      ns: 'gw1',
      epoch: 'E1',
      transport: () => {
        const p = spawn('sh', ['-c', 'echo "ssh: connect to host nowhere port 22: Connection refused" >&2; exit 255']);
        transports.push(p);
        return p;
      },
      binary: () => undefined,
    });
    hosts.push(host);
    const child = host.spawn('cat', []);
    const err = await new Promise<Error>((resolve) => child.on('error', resolve));
    expect(err.message).toMatch(/cannot reach host "nowhere".*Connection refused/);
  }, 30_000);

  it('keeps the agent running through a dropped connection and delivers what it said meanwhile', async () => {
    const home = newHome();
    const host = makeHost(home);
    const events: string[] = [];
    host.on('down', () => events.push('down'));
    host.on('up', (resumed: boolean) => events.push(resumed ? 'up:resumed' : 'up:fresh'));
    const child = host.spawn('sh', ['-c', 'echo early; sleep 1.5; echo late; read line; echo "got $line"']);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await waitFor(() => out === 'early\n');

    // The network goes away: the ssh process dies under the link.
    for (const p of transports) p.kill('SIGKILL');
    await waitFor(() => events.includes('down'));
    // Typed while disconnected: queued in the link, delivered after the reconnect.
    child.stdin.write('typed-offline\n');

    const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await waitFor(() => events.includes('up:resumed'), 15_000);
    expect(await exit).toBe(0);
    expect(out).toBe('early\nlate\ngot typed-offline\n');
  }, 30_000);

  it('a daemon that restarted takes down what it ran, but not what was asked for while it was away', async () => {
    // The everyday shape of this: the gateway closes an idle connection, the host's daemon exits ten
    // minutes later, and the next request reconnects to a new one. That request never reached the
    // old daemon, so it has nothing to lose — yet queued in the link it was failed with the rest as
    // "restarted", which cost every quiet host its next directory menu (2026-10-30).
    const home = newHome();
    mkdirSync(join(home, 'ws', 'proj'), { recursive: true });
    const host = makeHost(home);
    const old = host.spawn('sleep', ['30']);
    await new Promise((r) => old.on('spawn', r));
    const oldExit = new Promise<string | null>((resolve) => old.on('exit', (_code, signal) => resolve(signal)));

    // Asked for the moment the connection is gone, so before any reconnect.
    let listing: Promise<Array<{ name: string; dir: boolean }>> | undefined;
    let fresh: RemoteChild | undefined;
    host.once('down', () => {
      listing = host.listDir('~/ws', 15_000);
      fresh = host.spawn('sh', ['-c', 'echo hi']);
    });
    const daemonPid = Number(readFileSync(join(home, '.talkcode/remote/run/gw1/daemon.pid'), 'utf8').trim());
    process.kill(daemonPid, 'SIGTERM');
    await waitFor(() => !pidAlive(daemonPid));
    for (const p of transports) p.kill('SIGKILL');
    await waitFor(() => fresh !== undefined);

    expect(await oldExit).toBe('SIGKILL');
    expect(await listing).toEqual([{ name: 'proj', dir: true }]);
    expect(await collect(fresh!)).toMatchObject({ out: 'hi\n', code: 0 });
  }, 30_000);

  it('runs operations on the host: files, tails, links, commands', async () => {
    const home = newHome();
    const host = makeHost(home);
    await host.writeFile('~/att/pic.bin', Buffer.from([1, 2, 3]));
    expect([...(await host.readFile(`${home}/att/pic.bin`, 10))]).toEqual([1, 2, 3]);
    await expect(host.readFile('~/att/pic.bin', 2)).rejects.toThrow(/over the 2-byte limit/);
    expect(await host.stat('~/att')).toMatchObject({ exists: true, dir: true });

    writeFileSync(join(home, 't.jsonl'), 'a usage\nnoise\nb usage\n');
    expect(await host.readTail('~/t.jsonl', 1 << 20, { grep: ['usage'] })).toBe('a usage\nb usage');

    mkdirSync(join(home, 'ws', 'proj'), { recursive: true });
    expect(await host.listDir('~/ws')).toEqual([{ name: 'proj', dir: true }]);

    mkdirSync(join(home, '.claude'));
    expect((await host.ensureLink('~/skill', '~/.claude/skills/talkcode', '~/.claude')).outcome).toBe('linked');

    const r = await host.run({ bash: 'echo "$X"; echo err >&2; exit 2', env: { X: 'from-gateway' }, merge: true });
    expect(r.code).toBe(2);
    expect(r.output.toString()).toBe('from-gateway\nerr\n');
    const t = await host.run({ bash: 'sleep 20', timeoutMs: 200 });
    expect(t.timedOut).toBe(true);
  }, 30_000);

  it('places the operator\'s instructions: a whole read-only copy, a link only where it is ours', async () => {
    const home = newHome();
    const host = makeHost(home);
    const owned = '~/.talkcode/instructions';
    mkdirSync(join(home, '.codex'));

    for (const text of ['first\n', 'second\n']) {
      await host.writeFile(`${owned}/codex.md`, Buffer.from(text), 0o444, { atomic: true });
      expect(readFileSync(join(home, '.talkcode', 'instructions', 'codex.md'), 'utf8')).toBe(text);
    }
    expect((await host.ensureLink(`${owned}/codex.md`, '~/.codex/AGENTS.md', '~/.codex', owned)).outcome).toBe('linked');
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe('second\n');
    expect((await host.removeLink('~/.codex/AGENTS.md', owned)).outcome).toBe('removed');

    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'mine');
    expect((await host.ensureLink(`${owned}/codex.md`, '~/.codex/AGENTS.md', '~/.codex', owned)).outcome).toBe('occupied');
    expect((await host.removeLink('~/.codex/AGENTS.md', owned)).outcome).toBe('kept');
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe('mine');
  }, 30_000);

  it('bridges an agent\'s `talkcode` command back to the gateway', async () => {
    const seen: Array<{ argv: string[]; token: string; cwd: string }> = [];
    const cli: CliBridge = (req, io) => {
      seen.push({ argv: req.argv, token: req.token, cwd: req.cwd });
      let input = '';
      return {
        write: (d) => (input += d.toString()),
        end: () => {
          io.out(1, Buffer.from(`ran ${req.argv.join(' ')} with "${input}"\n`));
          io.exit(3);
        },
        kill: () => {},
      };
    };
    const home = newHome();
    const host = makeHost(home, { cli });
    const child = host.spawn('sh', ['-c', 'cd ~ && echo piped | talkcode send-message hi; echo "rc=$?"'], {
      env: { TALKCODE_TURN_TOKEN: 'tok-1' },
    });
    const { out } = await collect(child);
    expect(out).toBe('ran send-message hi with "piped\n"\nrc=3\n');
    expect(seen).toEqual([{ argv: ['send-message', 'hi'], token: 'tok-1', cwd: home }]);
  }, 30_000);

  it('a restarted gateway (new epoch) stops the agents of the old one', async () => {
    const home = newHome();
    const first = makeHost(home, { epoch: 'E1' });
    const child = first.spawn('sleep', ['30']);
    await new Promise((r) => child.on('spawn', r));
    const pid = child.pid!;
    expect(pidAlive(pid)).toBe(true);
    first.close();

    const second = makeHost(home, { epoch: 'E2' });
    expect((await second.ready()).resumed).toBe(false);
    await waitFor(() => !pidAlive(pid));
  }, 30_000);

  it('a new gateway version retires the old daemon, its agents, and its directory', async () => {
    const home = newHome();
    const v1 = makeHost(home, { epoch: 'E1', version: 'test-v1' });
    const child = v1.spawn('sleep', ['30']);
    await new Promise((r) => child.on('spawn', r));
    const w1 = await v1.ready();
    v1.close();

    const v2 = makeHost(home, { epoch: 'E2', version: 'test-v2' });
    const w2 = await v2.ready();
    expect(w2.version).toBe('test-v2');
    expect(w2.pid).not.toBe(w1.pid);
    await waitFor(() => !pidAlive(w1.pid) && !pidAlive(child.pid!));
    expect(existsSync(join(home, '.talkcode/remote/test-v1'))).toBe(false);
    expect(existsSync(join(home, '.talkcode/remote/test-v2/talkcode-remote'))).toBe(true);
  }, 30_000);
});
