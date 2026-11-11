import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRawConfigIfExists } from '../config/load.js';
import { addPod, gatewayKeyLine, removePod } from './pod-admin.js';
import { PRIVATE_SOURCES } from './pod-peers.js';

/**
 * Adding and removing a host from a chat (`fleetherd pod-add` / `pod-remove`): config.yaml and the
 * gateway's known_hosts change together, and a request that would leave either wrong is refused
 * before anything is written.
 */

let dir: string;
let known: string;
const saved = process.env.FLEETHERD_CONFIG_FILE;
const CONFIG = `# operator's note
platforms:
  tg: { type: telegram, token: t }
hosts:
  uniagent:
    ssh: user@uniagent:22   # main
agents:
  - id: x
    harness: claude
    host: uniagent
routing:
  default: x
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-podadmin-'));
  process.env.FLEETHERD_CONFIG_FILE = path.join(dir, 'config.yaml');
  fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
  known = path.join(dir, 'ssh', 'known_hosts');
  fs.mkdirSync(path.dirname(known), { recursive: true });
  fs.writeFileSync(known, 'uniagent ssh-ed25519 MAIN\n');
});
afterEach(() => {
  if (saved === undefined) delete process.env.FLEETHERD_CONFIG_FILE;
  else process.env.FLEETHERD_CONFIG_FILE = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const hostsOf = () => readRawConfigIfExists()?.hosts as Record<string, { ssh: string }>;

describe('addPod', () => {
  it('adds hosts.<name> beside the others, comments kept, and pins its key as ssh would name it', () => {
    addPod('aws', 'user@192.0.2.35:22023', 'ssh-ed25519 AAAAkey root@box', known);
    expect(hostsOf().aws).toEqual({ ssh: 'user@192.0.2.35:22023' });
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toMatch(/# operator's note[\s\S]*# main/);
    expect(fs.readFileSync(known, 'utf8')).toBe('uniagent ssh-ed25519 MAIN\n[192.0.2.35]:22023 ssh-ed25519 AAAAkey\n');
  });

  it('names a port-22 host without brackets', () => {
    addPod('box', 'user@192.0.2.9', 'ssh-ed25519 AAAAk', known);
    expect(fs.readFileSync(known, 'utf8')).toContain('\n192.0.2.9 ssh-ed25519 AAAAk\n');
  });

  it.each([
    ['a name in use', 'uniagent', 'user@192.0.2.9', 'ssh-ed25519 AAAAk', /already exists/],
    ['a bad name', 'no spaces', 'user@192.0.2.9', 'ssh-ed25519 AAAAk', /cannot name a host/],
    ['a bad address', 'box', "user@192.0.2.9 'x'", 'ssh-ed25519 AAAAk', /no spaces or quotes/],
    ['something that is not a key', 'box', 'user@192.0.2.9', 'SHA256:abcdef', /public key line/],
  ])('refuses %s, writing nothing', (_what, name, ssh, key, why) => {
    const before = [fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), fs.readFileSync(known, 'utf8')];
    expect(() => addPod(name, ssh, key, known)).toThrow(why);
    expect([fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), fs.readFileSync(known, 'utf8')]).toEqual(before);
  });

  it('refuses an address the gateway already pins a different key for', () => {
    fs.appendFileSync(known, '[192.0.2.9]:2222 ssh-ed25519 OLD\n');
    expect(() => addPod('box', 'user@192.0.2.9:2222', 'ssh-ed25519 NEW', known)).toThrow(/different key/);
    expect(hostsOf().box).toBeUndefined();
  });
});

describe('removePod', () => {
  it('removes the host and the key pinned for its address', () => {
    addPod('aws', 'user@192.0.2.35:22023', 'ssh-ed25519 AAAAkey', known);
    removePod('aws', known);
    expect(hostsOf().aws).toBeUndefined();
    expect(fs.readFileSync(known, 'utf8')).toBe('uniagent ssh-ed25519 MAIN\n');
  });

  it('keeps a pinned key another host still uses', () => {
    addPod('aws', 'user@192.0.2.35:22023', 'ssh-ed25519 AAAAkey', known);
    addPod('aws2', 'other@192.0.2.35:22023', 'ssh-ed25519 AAAAkey', known);
    removePod('aws', known);
    expect(fs.readFileSync(known, 'utf8')).toContain('[192.0.2.35]:22023');
  });

  it('refuses while config.yaml defines agents on it, or routing names one of its agents', () => {
    expect(() => removePod('uniagent', known)).toThrow(/defines agents on "uniagent" \(x\)/);
    addPod('aws', 'user@192.0.2.9', 'ssh-ed25519 AAAAk', known);
    fs.writeFileSync(path.join(dir, 'config.yaml'), fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').replace('default: x', 'default: oc@aws'));
    expect(() => removePod('aws', known)).toThrow(/routing in config.yaml names oc@aws/);
    expect(() => removePod('nope', known)).toThrow(/no host "nope"/);
  });
});

describe('gatewayKeyLine', () => {
  it('makes the gateway a key when it has none, and offers it restricted to private addresses', () => {
    const id = path.join(dir, 'ssh', 'id_ed25519');
    const line = gatewayKeyLine(id);
    expect(fs.existsSync(id)).toBe(true);
    expect(line).toMatch(new RegExp(`^restrict,from="${PRIVATE_SOURCES.replace(/\./g, '\\.')}" ssh-ed25519 \\S+ fleetherd-gateway$`));
    expect(gatewayKeyLine(id)).toBe(line);
  });
});
