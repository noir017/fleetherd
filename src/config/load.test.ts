import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, configPath, defaultSocketPath } from './load.js';
import { legacyConfigDirNote } from '../legacy-name.js';

/**
 * configPath/configDir resolution precedence: FLEETHERD_CONFIG_FILE (the `--config` flag, plumbed
 * through process.env so the spawned agent's reverse commands resolve the same file) overrides
 * FLEETHERD_CONFIG_DIR, which overrides the ~/.config/fleetherd default.
 */
describe('config path resolution', () => {
  const NAMES = ['FLEETHERD_CONFIG_FILE', 'FLEETHERD_CONFIG_DIR', 'TALKCODE_CONFIG_FILE', 'TALKCODE_CONFIG_DIR', 'HOME'] as const;
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    vi.restoreAllMocks();
  });
  /** A home of its own: the default depends on what exists under it, and this machine's is live. */
  const freshHome = (): string => {
    for (const n of NAMES) delete process.env[n];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-home-'));
    homes.push(home);
    process.env.HOME = home;
    return home;
  };

  it('defaults to ~/.config/fleetherd/config.yaml', () => {
    const home = freshHome();
    expect(configPath()).toBe(path.join(home, '.config', 'fleetherd', 'config.yaml'));
  });

  // 3.0.0 compatibility (legacy-name.ts): a gateway set up as talkcode keeps its config directory
  // where it is — it may be a bind mount, and config.yaml may hold absolute paths into it.
  it('uses ~/.config/talkcode when only that exists, silently — the daemon says so, not every command', () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, '.config', 'talkcode'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(configDir()).toBe(path.join(home, '.config', 'talkcode'));
    expect(configPath()).toBe(path.join(home, '.config', 'talkcode', 'config.yaml'));
    expect(fs.existsSync(path.join(home, '.config', 'fleetherd'))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    // What start logs: keep it where it is, and if moving, move the absolute paths with it.
    const note = legacyConfigDirNote(configDir(), home)!;
    expect(note).toMatch(/as it is/);
    expect(note).toMatch(/absolute path/);
    expect(legacyConfigDirNote(path.join(home, '.config', 'fleetherd'), home)).toBeUndefined();
  });

  it('prefers ~/.config/fleetherd once it exists, even with ~/.config/talkcode beside it', () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, '.config', 'talkcode'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'fleetherd'), { recursive: true });
    expect(configDir()).toBe(path.join(home, '.config', 'fleetherd'));
  });

  it('reads TALKCODE_CONFIG_DIR / TALKCODE_CONFIG_FILE when the FLEETHERD_ ones are unset', () => {
    freshHome();
    process.env.TALKCODE_CONFIG_DIR = '/srv/old';
    expect(configDir()).toBe('/srv/old');
    process.env.FLEETHERD_CONFIG_DIR = '/srv/new';
    expect(configDir()).toBe('/srv/new');
    process.env.TALKCODE_CONFIG_FILE = '/etc/old/c.yaml';
    expect(configPath()).toBe(path.resolve('/etc/old/c.yaml'));
    process.env.FLEETHERD_CONFIG_FILE = '/etc/new/c.yaml';
    expect(configPath()).toBe(path.resolve('/etc/new/c.yaml'));
  });

  // The precedence rules are platform-independent, but the paths they produce are not: configPath
  // joins/resolves with the host separator, and on Windows path.resolve('/etc/x') also gains the
  // current drive letter. So the expectations are built with the same primitives the implementation
  // uses — asserting literal POSIX strings only tested that the suite was running on POSIX.
  it('honors FLEETHERD_CONFIG_DIR', () => {
    delete process.env.FLEETHERD_CONFIG_FILE;
    process.env.FLEETHERD_CONFIG_DIR = '/srv/am';
    expect(configPath()).toBe(path.join('/srv/am', 'config.yaml'));
    expect(defaultSocketPath()).toBe(path.join('/srv/am', 'daemon.sock'));
  });

  it('FLEETHERD_CONFIG_FILE points configPath at the file and configDir at its parent', () => {
    process.env.FLEETHERD_CONFIG_DIR = '/srv/am'; // must be ignored when FILE is set
    process.env.FLEETHERD_CONFIG_FILE = '/etc/fleetherd/discord.yaml';
    const resolved = path.resolve('/etc/fleetherd/discord.yaml');
    expect(configPath()).toBe(resolved);
    expect(configDir()).toBe(path.dirname(resolved));
    // socket sits next to the chosen file (one daemon at a time, so no collision with other configs).
    expect(defaultSocketPath()).toBe(path.join(path.dirname(resolved), 'daemon.sock'));
  });

  it('expands a leading ~ in FLEETHERD_CONFIG_FILE', () => {
    process.env.FLEETHERD_CONFIG_FILE = '~/am/discord.yaml';
    expect(configPath()).toBe(path.join(os.homedir(), 'am', 'discord.yaml'));
  });
});
