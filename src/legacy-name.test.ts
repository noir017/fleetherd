import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteEnv, envOf, isUnderEitherName, metaKeys, migrateHostDir, withLegacyNames } from './legacy-name.js';

// The 3.0.0 compatibility with the name talkcode. These go with legacy-name.ts in the next major.

describe('environment variables', () => {
  it('reads TALKCODE_<name> only when FLEETHERD_<name> is unset', () => {
    expect(envOf('CWD', { TALKCODE_CWD: '/old' })).toBe('/old');
    expect(envOf('CWD', { TALKCODE_CWD: '/old', FLEETHERD_CWD: '/new' })).toBe('/new');
    expect(envOf('CWD', { FLEETHERD_CWD: '', TALKCODE_CWD: '/old' })).toBe(''); // set, if empty
    expect(envOf('CWD', {})).toBeUndefined();
  });

  it('gives every FLEETHERD_ variable its old name too, for a CLI older than 3.0.0', () => {
    const env = withLegacyNames<Record<string, string | undefined>>({ FLEETHERD_TURN_TOKEN: 't', FLEETHERD_SOCKET: '/s', PATH: '/bin', TALKCODE_TURN_TOKEN: 'stale' });
    expect(env).toEqual({ FLEETHERD_TURN_TOKEN: 't', FLEETHERD_SOCKET: '/s', PATH: '/bin', TALKCODE_TURN_TOKEN: 't', TALKCODE_SOCKET: '/s' });
  });

  it('deletes both names', () => {
    const env: Record<string, string | undefined> = { FLEETHERD_TURN_TOKEN: 'a', TALKCODE_TURN_TOKEN: 'b', PATH: '/bin' };
    deleteEnv(env, 'TURN_TOKEN');
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('the per-host directory on this machine (migrateHostDir)', () => {
  const homes: string[] = [];
  const home = (): string => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-mig-'));
    homes.push(h);
    return h;
  };
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it('moves ~/.talkcode to ~/.fleetherd and leaves a link at the old name', () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.talkcode', 'agents', 'cc'), { recursive: true });
    fs.writeFileSync(path.join(h, '.talkcode', 'pod.yaml'), 'agents: []\n');
    expect(migrateHostDir(h)).toMatch(/^moved /);
    expect(fs.lstatSync(path.join(h, '.fleetherd')).isDirectory()).toBe(true);
    expect(fs.readlinkSync(path.join(h, '.talkcode'))).toBe('.fleetherd');
    // What pointed into the old path still resolves, to the same files.
    expect(fs.readFileSync(path.join(h, '.talkcode', 'pod.yaml'), 'utf8')).toBe('agents: []\n');
    expect(fs.existsSync(path.join(h, '.fleetherd', 'agents', 'cc'))).toBe(true);
    // Done once: a second start finds the link and leaves everything as it is.
    expect(migrateHostDir(h)).toBeUndefined();
  });

  it('leaves both alone when ~/.fleetherd already exists', () => {
    const h = home();
    fs.mkdirSync(path.join(h, '.talkcode'));
    fs.mkdirSync(path.join(h, '.fleetherd'));
    expect(migrateHostDir(h)).toBeUndefined();
    expect(fs.lstatSync(path.join(h, '.talkcode')).isDirectory()).toBe(true);
  });

  it('does nothing without a ~/.talkcode, or when it is the operator’s own link', () => {
    const h = home();
    expect(migrateHostDir(h)).toBeUndefined();
    expect(fs.existsSync(path.join(h, '.fleetherd'))).toBe(false);
    fs.mkdirSync(path.join(h, 'elsewhere'));
    fs.symlinkSync('elsewhere', path.join(h, '.talkcode'));
    expect(migrateHostDir(h)).toBeUndefined();
    expect(fs.existsSync(path.join(h, '.fleetherd'))).toBe(false);
  });
});

describe('paths under either name', () => {
  it('counts a link into ~/.talkcode/… as inside ~/.fleetherd/…', () => {
    expect(isUnderEitherName('/h/.talkcode/skills/foo', '/h/.fleetherd/skills')).toBe(true);
    expect(isUnderEitherName('/h/.fleetherd/skills/foo', '/h/.fleetherd/skills')).toBe(true);
    expect(isUnderEitherName('/h/talkcode-notes/skills/foo', '/h/.fleetherd/skills')).toBe(false);
    expect(isUnderEitherName('/h/.talkcode/skills', '/h/.fleetherd/skills')).toBe(false); // the directory itself is not inside
    expect(isUnderEitherName('/h/.talkcode/other/foo', '/h/.fleetherd/skills')).toBe(false);
    expect(isUnderEitherName('/srv/x/foo', '/srv/x')).toBe(true); // not a host directory: unchanged
  });

  it('spells each skill metadata key both ways, the current one first', () => {
    expect(metaKeys('fleetherd-resident')).toEqual(['fleetherd-resident', 'talkcode-resident']);
    expect(metaKeys('fleetherd-category')).toEqual(['fleetherd-category', 'talkcode-category']);
  });
});
