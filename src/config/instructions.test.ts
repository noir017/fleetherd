import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  instructionClashes,
  instructionConflictMessage,
  instructionsHome,
  instructionsOff,
  type PlacedInstructionsAgent,
} from './instructions.js';
import { readConfig } from './load.js';
import { ConfigSchema } from './schema.js';

/**
 * The table delivery uses (instructionsHome) and the load-time refusal built on it: two agents on
 * one machine whose instruction files resolve to the same path may share a layer, but may not name
 * two — one link cannot point at both.
 */

describe('instructionsHome', () => {
  it('puts each harness at the user-level file it was observed to read', () => {
    expect(instructionsHome({ id: 'cc', harness: 'claude' }, '/h')).toEqual({
      name: 'claude',
      file: '/h/.claude/CLAUDE.md',
      requires: '/h/.claude',
    });
    expect(instructionsHome({ id: 'cx', harness: 'codex' }, '/h')).toEqual({
      name: 'codex',
      file: '/h/.codex/AGENTS.md',
      requires: '/h/.codex',
    });
    expect(instructionsHome({ id: 'oc', harness: 'opencode' }, '/h')).toEqual({
      name: 'opencode',
      file: '/h/.config/opencode/AGENTS.md',
      requires: '/h/.config/opencode',
    });
    // The customization root agy reads skills from — not its own antigravity-cli directory.
    expect(instructionsHome({ id: 'ag', harness: 'agy' }, '/h')).toEqual({
      name: 'agy',
      file: '/h/.gemini/config/AGENTS.md',
      requires: '/h/.gemini/antigravity-cli',
    });
  });

  it('knows CodeBuddy and AtomCode by their command, and guesses nothing else', () => {
    expect(instructionsHome({ id: 'cb', harness: 'custom', command: '/usr/local/bin/codebuddy' }, '/h')).toEqual({
      name: 'codebuddy',
      file: '/h/.codebuddy/CODEBUDDY.md',
      requires: '/h/.codebuddy',
    });
    expect(instructionsHome({ id: 'ac', harness: 'custom', command: 'atomcode' }, '/h')).toEqual({
      name: 'atomcode',
      file: '/h/.atomcode/ATOMCODE.md',
      requires: '/h/.atomcode',
    });
    for (const command of ['/opt/other/thing', '', undefined]) {
      expect(instructionsHome({ id: 'x', harness: 'custom', command }, '/h')).toBeUndefined();
    }
    for (const harness of ['gemini', 'dsh'] as const) expect(instructionsHome({ id: 'x', harness }, '/h')).toBeUndefined();
  });

  it('takes the file and layer an agent names, defaulting the layer to its id', () => {
    expect(
      instructionsHome(
        { id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } },
        '/h'
      )
    ).toEqual({ name: 'mh', file: '/h/.my-harness/AGENTS.md', requires: '/h/.my-harness' });
    expect(
      instructionsHome(
        { id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '/opt/my/AGENTS.md', layer: 'my-harness' } },
        '/h'
      )
    ).toEqual({ name: 'my-harness', file: '/opt/my/AGENTS.md', requires: '/opt/my' });
    // An `env.HOME` override is the home the caller passes, so `~` follows it.
    expect(
      instructionsHome(
        { id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } },
        '/home/other'
      )
    ).toMatchObject({ file: '/home/other/.my-harness/AGENTS.md' });
    // `..` in an absolute path is resolved, so two spellings of one file are one path.
    expect(
      instructionsHome({ id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '/a/x/../y/F' } }, '/h')
    ).toMatchObject({ file: '/a/y/F' });
  });

  it('refuses a layer that is not a plain file name, so nothing can be read outside the directory', () => {
    for (const layer of ['../x', 'a/b', '..', 'Common', 'COMMON', '.hidden', '']) {
      expect(
        instructionsHome({ id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/f.md', layer } }, '/h'),
        layer
      ).toBeUndefined();
    }
    // The id is the default layer, and an id that is not a file name delivers nothing either.
    expect(
      instructionsHome({ id: 'mh@box', harness: 'custom', command: 'my-harness', instructions: { file: '~/f.md' } }, '/h')
    ).toBeUndefined();
    // A legal custom layer still resolves.
    expect(
      instructionsHome({ id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/f.md', layer: 'my-harness' } }, '/h')
    ).toMatchObject({ name: 'my-harness' });
  });

  it('keeps the placement of an agent whose delivery the merge turned off, and says it is off', () => {
    const off = { file: '~/.claude/CLAUDE.md', layer: 'claude', off: true as const };
    expect(instructionsHome({ id: 'cc', harness: 'claude', instructions: off }, '/h')).toEqual({
      name: 'claude',
      file: '/h/.claude/CLAUDE.md',
      requires: '/h/.claude',
    });
    expect(instructionsOff({ id: 'cc', harness: 'claude', instructions: off })).toBe(true);
    expect(instructionsOff({ id: 'cc', harness: 'claude' })).toBe(false);
    expect(instructionsOff({ id: 'mh', harness: 'custom', command: 'my-harness', instructions: { file: '~/x' } })).toBe(false);
    // A non-object is not a marker, and must not throw on `'off' in`.
    expect(instructionsOff({ id: 'cc', harness: 'claude', instructions: false as unknown as { file: string } })).toBe(false);
  });
});

const claude = (id: string, extra: Partial<PlacedInstructionsAgent> = {}): PlacedInstructionsAgent => ({
  id,
  harness: 'claude',
  ...extra,
});

/** The clashes as the sentences a refused config would carry. */
const conflicts = (agents: readonly PlacedInstructionsAgent[]): string[] =>
  instructionClashes(agents).map(instructionConflictMessage);

describe('instructionClashes', () => {
  it('lets two agents of one harness share its layer and file, which is the ordinary case', () => {
    expect(conflicts([claude('cc'), claude('cc2')])).toEqual([]);
  });

  it('names both agents, the file and each layer when one file would get two layers', () => {
    const [message, ...rest] = conflicts([claude('cc'), claude('cc2', { instructions: { file: '~/.claude/CLAUDE.md' } })]);
    expect(rest).toEqual([]);
    expect(message).toBe(
      'agents "cc" (layer "claude") and "cc2" (layer "cc2") deliver the same file ~/.claude/CLAUDE.md ' +
        'on this machine, but their layers differ; one file can only hold one layer — give them the same ' +
        'instructions.layer, or different files'
    );
  });

  it('names the host, and every agent in a group of three', () => {
    const custom = (id: string, layer?: string): PlacedInstructionsAgent => ({
      id,
      harness: 'custom',
      command: 'my-harness',
      host: 'box',
      instructions: { file: '~/.my-harness/AGENTS.md', ...(layer ? { layer } : {}) },
    });
    const [message] = conflicts([custom('a'), custom('b', 'b'), custom('c', 'c')]);
    expect(message).toContain('agents "a" (layer "a"), "b" (layer "b") and "c" (layer "c")');
    expect(message).toContain('~/.my-harness/AGENTS.md on host "box"');
  });

  it('says nothing about the same path on two different machines', () => {
    const on = (id: string, host: string): PlacedInstructionsAgent => ({
      id,
      harness: 'custom',
      command: 'my-harness',
      host,
      instructions: { file: '~/.my-harness/AGENTS.md', layer: id },
    });
    expect(conflicts([on('a', 'one'), on('b', 'two')])).toEqual([]);
  });

  it("follows an env.HOME override, so two homes are two files", () => {
    const at = (id: string, home: string): PlacedInstructionsAgent =>
      claude(id, { host: 'box', env: { HOME: home }, instructions: { file: '~/.claude/CLAUDE.md', layer: id } });
    expect(conflicts([at('a', '/srv/a'), at('b', '/srv/b')])).toEqual([]);
    expect(conflicts([at('a', '/srv/a'), at('b', '/srv/a')])).toHaveLength(1);
  });

  // Two different homes can still name one absolute file, and the link collides just the same.
  it('groups by the resolved file, not by the home it was resolved against', () => {
    const at = (id: string, home: string): PlacedInstructionsAgent =>
      claude(id, { host: 'box', env: { HOME: home }, instructions: { file: '/opt/shared/AGENTS.md', layer: id } });
    expect(conflicts([at('a', '/srv/a'), at('b', '/srv/b')])).toHaveLength(1);
  });

  it('ignores an agent whose harness has no file it knows', () => {
    expect(
      conflicts([
        { id: 'gm', harness: 'gemini' },
        { id: 'mh', harness: 'custom', command: 'my-harness' },
      ])
    ).toEqual([]);
  });

  it('does not count an agent whose delivery was turned off: it takes no file', () => {
    const off = claude('cc2', { instructions: { file: '~/.claude/CLAUDE.md', layer: 'cc2', off: true } });
    expect(conflicts([claude('cc'), off])).toEqual([]);
  });

  it('normalises .. in an absolute path, so two spellings of one file clash', () => {
    const at = (id: string, file: string): PlacedInstructionsAgent =>
      claude(id, { host: 'box', instructions: { file, layer: id } });
    const [message] = conflicts([at('a', '/a/x/../y/F'), at('b', '/a/y/F')]);
    expect(message).toContain('/a/y/F');
    expect(message).not.toContain('..');
  });
});

describe('ConfigSchema', () => {
  const base = (agents: unknown[]) => ({
    platforms: { tg: { type: 'telegram', token: 't' } },
    hosts: { one: { ssh: 'u@one' }, two: { ssh: 'u@two' } },
    agents,
    routing: { default: 'cc' },
  });

  it('refuses two agents in config.yaml that share a file under two layers', () => {
    const r = ConfigSchema.safeParse(
      base([{ id: 'cc', harness: 'claude' }, { id: 'cc2', harness: 'claude', instructions: { file: '~/.claude/CLAUDE.md' } }])
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join('\n')).toMatch(/"cc" \(layer "claude"\) and "cc2" \(layer "cc2"\)/);
  });

  it('accepts the same path on two hosts, and the same layer on one', () => {
    expect(
      ConfigSchema.safeParse(
        base([
          { id: 'cc', harness: 'claude', host: 'one' },
          { id: 'cc2', harness: 'claude', host: 'two', instructions: { file: '~/.claude/CLAUDE.md' } },
        ])
      ).success
    ).toBe(true);
    expect(ConfigSchema.safeParse(base([{ id: 'cc', harness: 'claude' }, { id: 'cc2', harness: 'claude' }])).success).toBe(true);
  });
});

describe('readConfig', () => {
  let dir: string;
  const saved = process.env.FLEETHERD_CONFIG_FILE;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetherd-instructions-'));
    process.env.FLEETHERD_CONFIG_FILE = path.join(dir, 'config.yaml');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FLEETHERD_CONFIG_FILE;
    else process.env.FLEETHERD_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects the whole file, so the old config keeps running (loadConfig and /reload both read here)', () => {
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      `platforms:
  tg: { type: telegram, token: t }
agents:
  - id: cc
    harness: claude
  - id: cc2
    harness: claude
    instructions: { file: '~/.claude/CLAUDE.md' }
routing:
  default: cc
`
    );
    expect(() => readConfig()).toThrow(/config validation failed[\s\S]*agents: agents "cc" \(layer "claude"\) and "cc2" \(layer "cc2"\)/);
  });
});
