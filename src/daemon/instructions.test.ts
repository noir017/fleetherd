import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import {
  INSTRUCTIONS_MAX_BYTES,
  applyInstructions,
  commonInstructions,
  composeInstructions,
  instructionsHome,
  ownedDir,
  placeInstructions,
  type InstructionsHome,
} from './instructions.js';
import { RemoteHosts } from './remote-hosts.js';

/**
 * Placing instructions writes into the operator's own directories (`~/.codex/AGENTS.md`), so these
 * run `applyInstructions` against a throwaway home only, and pin that the guarded entry point does
 * nothing from a test worker — the same discipline as skill-link.test.ts.
 */

let home: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'instructions-'));
  dir = path.join(home, 'gateway', 'instructions');
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const codex = (): InstructionsHome => instructionsHome('codex', home)!;

describe('instructionsHome', () => {
  it('puts each harness at the user-level file it was observed to read', () => {
    expect(instructionsHome('claude', '/h')).toEqual({ name: 'claude', file: '/h/.claude/CLAUDE.md', requires: '/h/.claude' });
    expect(instructionsHome('codex', '/h')).toEqual({ name: 'codex', file: '/h/.codex/AGENTS.md', requires: '/h/.codex' });
    expect(instructionsHome('opencode', '/h')).toEqual({
      name: 'opencode',
      file: '/h/.config/opencode/AGENTS.md',
      requires: '/h/.config/opencode',
    });
    // The customization root agy reads skills from — not its own antigravity-cli directory.
    expect(instructionsHome('agy', '/h')).toEqual({
      name: 'agy',
      file: '/h/.gemini/config/AGENTS.md',
      requires: '/h/.gemini/antigravity-cli',
    });
  });

  it('knows CodeBuddy and AtomCode by their command, and guesses nothing else', () => {
    expect(instructionsHome('custom', '/h', '/usr/local/bin/codebuddy')).toEqual({
      name: 'codebuddy',
      file: '/h/.codebuddy/CODEBUDDY.md',
      requires: '/h/.codebuddy',
    });
    expect(instructionsHome('custom', '/h', 'atomcode')).toEqual({
      name: 'atomcode',
      file: '/h/.atomcode/ATOMCODE.md',
      requires: '/h/.atomcode',
    });
    for (const command of ['/opt/other/thing', '', undefined]) expect(instructionsHome('custom', '/h', command)).toBeUndefined();
    for (const harness of ['gemini', 'dsh'] as const) expect(instructionsHome(harness, '/h')).toBeUndefined();
  });
});

describe('composeInstructions', () => {
  it('has nothing to deliver without the directory or either file', () => {
    expect(composeInstructions(path.join(home, 'nowhere'), 'codex')).toEqual({ kind: 'none' });
    expect(composeInstructions(dir, 'codex')).toEqual({ kind: 'none' });
    fs.writeFileSync(path.join(dir, 'common.md'), '  \n\n');
    expect(composeInstructions(dir, 'codex')).toEqual({ kind: 'none' });
  });

  it('puts the common layer first and the agent\'s own after it, and nobody else\'s', () => {
    fs.writeFileSync(path.join(dir, 'common.md'), '# Mine\n\n1. Answer in Chinese.\n\n');
    fs.writeFileSync(path.join(dir, 'claude.md'), 'Start fewer sub-agents.\n');
    fs.writeFileSync(path.join(dir, 'codex.md'), '\nRead the source first.\n');
    expect(composeInstructions(dir, 'claude')).toEqual({ kind: 'text', text: '# Mine\n\n1. Answer in Chinese.\n\nStart fewer sub-agents.\n' });
    expect(composeInstructions(dir, 'codex')).toEqual({ kind: 'text', text: '# Mine\n\n1. Answer in Chinese.\n\nRead the source first.\n' });
    expect(composeInstructions(dir, 'agy')).toEqual({ kind: 'text', text: '# Mine\n\n1. Answer in Chinese.\n' });
  });

  it('delivers an agent\'s own layer without a common one', () => {
    fs.writeFileSync(path.join(dir, 'claude.md'), 'Only for Claude.');
    expect(composeInstructions(dir, 'claude')).toEqual({ kind: 'text', text: 'Only for Claude.\n' });
    expect(composeInstructions(dir, 'codex')).toEqual({ kind: 'none' });
  });

  it('refuses a text over the limit rather than delivering part of it', () => {
    fs.writeFileSync(path.join(dir, 'common.md'), 'x'.repeat(INSTRUCTIONS_MAX_BYTES + 1));
    expect(composeInstructions(dir, 'codex')).toMatchObject({ kind: 'too-big' });
  });

  it('throws on a file it cannot read, so that never reads as "nothing to deliver"', () => {
    fs.mkdirSync(path.join(dir, 'common.md'));
    expect(() => composeInstructions(dir, 'codex')).toThrow();
  });
});

describe('commonInstructions', () => {
  it('is the common layer alone, trimmed, or nothing', () => {
    expect(commonInstructions(path.join(home, 'nowhere'))).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'claude.md'), 'Only for Claude.');
    expect(commonInstructions(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'common.md'), '\n1. Answer in Chinese.\n\n');
    expect(commonInstructions(dir)).toBe('1. Answer in Chinese.');
  });

  it('throws on a file it cannot read, for the review to log', () => {
    fs.mkdirSync(path.join(dir, 'common.md'));
    expect(() => commonInstructions(dir)).toThrow();
  });
});

describe('applyInstructions', () => {
  const text = (t: string) => ({ kind: 'text' as const, text: t });

  it('does nothing for a harness that has not run here', () => {
    expect(applyInstructions(text('a\n'), codex(), home).outcome).toBe('skipped');
    expect(fs.existsSync(ownedDir(home))).toBe(false);
  });

  it('writes a read-only copy and links the harness\'s file to it, then keeps it current', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const copy = path.join(ownedDir(home), 'codex.md');
    expect(applyInstructions(text('first\n'), codex(), home).outcome).toBe('linked');
    expect(fs.readlinkSync(codex().file)).toBe(copy);
    expect(fs.readFileSync(codex().file, 'utf8')).toBe('first\n');
    expect(fs.statSync(copy).mode & 0o777).toBe(0o444);

    // A changed text replaces the read-only copy; the link already points at it.
    expect(applyInstructions(text('second\n'), codex(), home).outcome).toBe('current');
    expect(fs.readFileSync(codex().file, 'utf8')).toBe('second\n');
    expect(fs.readdirSync(ownedDir(home))).toEqual(['codex.md']);
  });

  it('leaves a real file at the harness\'s path alone', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(codex().file, 'the operator\'s own');
    expect(applyInstructions(text('ours\n'), codex(), home)).toMatchObject({ outcome: 'occupied', detail: 'a file' });
    expect(fs.readFileSync(codex().file, 'utf8')).toBe('the operator\'s own');
  });

  it('leaves the operator\'s own link alone, and repoints only one of ours', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const theirs = path.join(home, 'notes', 'codex.md');
    fs.symlinkSync(theirs, codex().file);
    expect(applyInstructions(text('ours\n'), codex(), home)).toMatchObject({ outcome: 'occupied', detail: `a link to ${theirs}` });
    expect(fs.readlinkSync(codex().file)).toBe(theirs);

    fs.unlinkSync(codex().file);
    fs.symlinkSync(path.join(ownedDir(home), 'old.md'), codex().file);
    expect(applyInstructions(text('ours\n'), codex(), home).outcome).toBe('relinked');
    expect(fs.readFileSync(codex().file, 'utf8')).toBe('ours\n');
  });

  it('takes its link back when there is nothing to deliver, and only its own', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    expect(applyInstructions({ kind: 'none' }, codex(), home).outcome).toBe('absent');
    applyInstructions(text('ours\n'), codex(), home);
    expect(applyInstructions({ kind: 'none' }, codex(), home).outcome).toBe('removed');
    expect(fs.existsSync(codex().file)).toBe(false);

    fs.writeFileSync(codex().file, 'the operator\'s own');
    expect(applyInstructions({ kind: 'none' }, codex(), home).outcome).toBe('kept');
    expect(fs.readFileSync(codex().file, 'utf8')).toBe('the operator\'s own');
  });

  it('writes nothing for a text over the limit', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    expect(applyInstructions({ kind: 'too-big', bytes: 40_000 }, codex(), home).outcome).toBe('too-big');
    expect(fs.existsSync(codex().file)).toBe(false);
  });
});

describe('placeInstructions', () => {
  it('does nothing from a test worker, even with instructions to deliver', () => {
    const saved = process.env.TALKCODE_CONFIG_DIR;
    process.env.TALKCODE_CONFIG_DIR = path.dirname(dir);
    try {
      fs.writeFileSync(path.join(dir, 'common.md'), 'mine\n');
      fs.mkdirSync(path.join(home, '.codex'));
      const def = { id: 'cx', harness: 'codex', env: {} } as unknown as AgentDef;
      expect(placeInstructions(def, home)).toBeUndefined();
      expect(fs.existsSync(codex().file)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TALKCODE_CONFIG_DIR;
      else process.env.TALKCODE_CONFIG_DIR = saved;
    }
  });
});

describe('RemoteHosts.placeInstructions', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TALKCODE_CONFIG_DIR;
    process.env.TALKCODE_CONFIG_DIR = path.dirname(dir);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TALKCODE_CONFIG_DIR;
    else process.env.TALKCODE_CONFIG_DIR = saved;
    vi.restoreAllMocks();
  });

  function fakeHost(linkOutcome = 'linked') {
    const host = {
      id: 'box',
      writeFile: vi.fn(async () => {}),
      ensureLink: vi.fn(async (_t: string, link: string) => ({ outcome: linkOutcome, link })),
      removeLink: vi.fn(async (link: string) => ({ outcome: 'removed', link })),
    };
    return host;
  }
  const def = { id: 'cx', harness: 'codex', env: {} } as unknown as AgentDef;
  const welcome = { instance: 'i1', home: '/home/u' } as unknown as Welcome;

  it('sends the text composed here, and nothing more while it stays the same', async () => {
    const hosts = new RemoteHosts();
    const host = fakeHost();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, 'common.md'), 'mine\n');
    fs.writeFileSync(path.join(dir, 'codex.md'), 'codex only\n');

    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    expect(host.writeFile).toHaveBeenCalledWith(
      '/home/u/.talkcode/instructions/codex.md',
      Buffer.from('mine\n\ncodex only\n'),
      0o444,
      { atomic: true }
    );
    expect(host.ensureLink).toHaveBeenCalledWith(
      '/home/u/.talkcode/instructions/codex.md',
      '/home/u/.codex/AGENTS.md',
      '/home/u/.codex',
      '/home/u/.talkcode/instructions'
    );

    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    expect(host.writeFile).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(dir, 'codex.md'), 'changed\n');
    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    expect(host.writeFile).toHaveBeenCalledTimes(2);
  });

  it('tries again at the next spawn while something is in the way', async () => {
    const hosts = new RemoteHosts();
    const host = fakeHost('occupied');
    fs.writeFileSync(path.join(dir, 'common.md'), 'mine\n');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    expect(host.ensureLink).toHaveBeenCalledTimes(2);
  });

  it('takes the link back once when there is nothing to deliver', async () => {
    const hosts = new RemoteHosts();
    const host = fakeHost();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    await hosts.placeInstructions(host as unknown as RemoteHost, def, '/home/u', welcome);
    expect(host.removeLink).toHaveBeenCalledTimes(1);
    expect(host.removeLink).toHaveBeenCalledWith('/home/u/.codex/AGENTS.md', '/home/u/.talkcode/instructions');
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('places nothing for a harness with no known file', async () => {
    const hosts = new RemoteHosts();
    const host = fakeHost();
    fs.writeFileSync(path.join(dir, 'common.md'), 'mine\n');
    const dsh = { id: 'd', harness: 'dsh', env: {} } as unknown as AgentDef;
    await hosts.placeInstructions(host as unknown as RemoteHost, dsh, '/home/u', welcome);
    expect(host.writeFile).not.toHaveBeenCalled();
    expect(host.removeLink).not.toHaveBeenCalled();
  });
});
