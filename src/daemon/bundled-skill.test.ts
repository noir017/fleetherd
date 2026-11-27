import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { AgentDef } from '../config/schema.js';
import { LIBRARY_NAMES_MAX } from '../ipc/tools.js';
import type { Welcome } from '../remote/connection.js';
import { DESCRIPTION_MAX, appendToDescription, renderBundledSkill, withLibraryLine } from './bundled-skill.js';
import type { HostFiles } from './provision.js';
import { bundledSkillDir, bundledSkillsHome, createBundledSkillProvision, linkSkill, placeRendered, skillHomes, skillReaders } from './skill-link.js';
import { frontmatterFields, skillDir } from './skills-store.js';

/**
 * The bundled `fleetherd` skill carries the library line in its description, rendered into a copy of
 * the gateway's own — never into the package. What must hold: the frontmatter still parses as YAML
 * with only the description changed, the line fits the spec's limit or steps down, and a copy is
 * written only when its bytes change, locally and on a host alike.
 */

const FM = /^---\r?\n([\s\S]*?)\r?\n---/;
const yamlOf = (md: string): Record<string, unknown> => parse(FM.exec(md)![1]!) as Record<string, unknown>;
const bodyOf = (md: string): string => md.slice(FM.exec(md)![0].length);

/** A `skills categories` answer naming `named` per category. */
function cats(named: Record<string, string[]>): unknown {
  const categories = Object.entries(named).map(([name, library]) => ({ name, count: library.length, library }));
  const library = categories.reduce((n, c) => n + c.count, 0);
  return { total: library, library, categories };
}

const FOLDED = [
  '---',
  'name: demo',
  'description: >-',
  '  Send a file to the user; schedule',
  '  a prompt.',
  'license: MIT',
  '---',
  '',
  '# demo',
  '',
  'description: not frontmatter',
  '',
].join('\n');

describe('appendToDescription', () => {
  it('appends to a folded description and changes nothing else', () => {
    const out = appendToDescription(FOLDED, 'In the library: ops: deploy-check.')!;
    expect(yamlOf(out)).toEqual({
      name: 'demo',
      description: 'Send a file to the user; schedule a prompt. In the library: ops: deploy-check.',
      license: 'MIT',
    });
    expect(bodyOf(out)).toBe(bodyOf(FOLDED));
    // The gateway's own reader agrees with the YAML parser.
    expect(frontmatterFields(out).get('description')).toBe(yamlOf(out).description);
  });

  it('rewrites a quoted, a plain and a multi-line plain description the same way', () => {
    for (const entry of ['description: "Use when: a # b, \\"c\\""', "description: 'Use when: it''s late'", 'description: Use when ready', 'description: Use when\n  ready']) {
      const md = `---\nname: demo\n${entry}\nlicense: MIT\n---\nbody\n`;
      const before = yamlOf(md).description as string;
      const out = appendToDescription(md, 'In the library: x.')!;
      expect(yamlOf(out), entry).toEqual({ name: 'demo', description: `${before} In the library: x.`, license: 'MIT' });
    }
  });

  it('carries category names YAML would otherwise read as syntax', () => {
    const line = 'In the library: a: b #c "d\' [e] {f} &g *h !i |j >k %l @m `n: x-y.';
    const out = appendToDescription(FOLDED, line)!;
    expect(String(yamlOf(out).description).endsWith(line)).toBe(true);
  });

  it('keeps CRLF line endings and the blank line before the next key', () => {
    const md = '---\r\nname: demo\r\ndescription: >-\r\n  one\r\n  two\r\n\r\nlicense: MIT\r\n---\r\nbody\r\n';
    const out = appendToDescription(md, 'In the library: x.')!;
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain('\r\n\r\nlicense: MIT\r\n');
    expect(yamlOf(out)).toEqual({ name: 'demo', description: 'one two In the library: x.', license: 'MIT' });
  });

  it('folds a long description onto lines a person can read, which fold back to one', () => {
    const out = appendToDescription(FOLDED, `In the library: ops: ${Array.from({ length: 20 }, (_, i) => `skill-${i}`).join(', ')}.`)!;
    const lines = FM.exec(out)![1]!.split('\n');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    expect(String(yamlOf(out).description)).toMatch(/skill-0, skill-1, .*skill-19\.$/);
  });

  it('refuses what it cannot do safely, rather than guessing', () => {
    expect(appendToDescription('no frontmatter\n', 'x')).toBeUndefined();
    expect(appendToDescription('---\nname: demo\n---\nbody\n', 'x')).toBeUndefined();
    expect(appendToDescription('---\nname: demo\ndescription:\n  - a\n---\n', 'x')).toBeUndefined();
    expect(appendToDescription('---\nname: [demo\ndescription: a\n---\n', 'x')).toBeUndefined();
    expect(appendToDescription('---\nname: demo\ndescription: a\ndescription: b\n---\n', 'x')).toBeUndefined();
  });

  it('checks the rewrite by parsing it back: an anchor another key uses would be lost, so it refuses', () => {
    expect(appendToDescription('---\nname: demo\ndescription: &d hello\nsummary: *d\n---\nbody\n', 'In the library: x.')).toBeUndefined();
  });
});

describe('withLibraryLine', () => {
  it('leaves the skill byte for byte as it was when the library has nothing for these readers', () => {
    expect(withLibraryLine(FOLDED, { total: 0, library: 0, categories: [] })).toBe(FOLDED);
    expect(withLibraryLine(FOLDED, { total: 2, library: 1, categories: [{ name: 'ops', count: 2, library: [] }] })).toBe(FOLDED);
    expect(withLibraryLine(FOLDED, undefined)).toBe(FOLDED);
  });

  it('names the skills, and past LIBRARY_NAMES_MAX names counts them', () => {
    expect(yamlOf(withLibraryLine(FOLDED, cats({ ops: ['deploy-check'], other: ['email-reader'] }))).description).toMatch(
      / In the library: ops: deploy-check; other: email-reader\.$/
    );
    const many = cats({ other: Array.from({ length: LIBRARY_NAMES_MAX + 1 }, (_, i) => `s-${i}`) });
    expect(yamlOf(withLibraryLine(FOLDED, many)).description).toMatch(new RegExp(` In the library: other ${LIBRARY_NAMES_MAX + 1}\\.$`));
  });

  it('steps down to counts, then to nothing, to stay within the spec\'s description limit', () => {
    const near = (room: number): string => `---\nname: demo\ndescription: ${'w '.repeat((DESCRIPTION_MAX - room) / 2).trim()}\n---\n`;
    const named = cats({ other: ['a-long-skill-name', 'another-long-skill-name'] });
    const fits = (md: string): number => [...String(yamlOf(md).description)].length;
    // Room for counts (`In the library: other 2.`, 24) but not the names.
    const counts = withLibraryLine(near(30), named);
    expect(yamlOf(counts).description).toMatch(/ In the library: other 2\.$/);
    expect(fits(counts)).toBeLessThanOrEqual(DESCRIPTION_MAX);
    // Room for neither.
    expect(withLibraryLine(near(10), named)).toBe(near(10));
  });

  it('renders the shipped skill/SKILL.md — a change to its frontmatter must keep this green', () => {
    const shipped = fs.readFileSync(path.join(bundledSkillDir(), 'SKILL.md'), 'utf8');
    const out = withLibraryLine(shipped, cats({ 运维: ['vpn-edge-join'], other: ['antigravity-config'] }));
    const [before, after] = [yamlOf(shipped), yamlOf(out)];
    expect(after.description).toBe(`${String(before.description)} In the library: 运维: vpn-edge-join; other: antigravity-config.`);
    expect({ ...after, description: undefined }).toEqual({ ...before, description: undefined });
    expect(bodyOf(out)).toBe(bodyOf(shipped));
  });
});

describe('renderBundledSkill', () => {
  let source: string;
  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-src-'));
    fs.writeFileSync(path.join(source, 'SKILL.md'), FOLDED);
    fs.mkdirSync(path.join(source, 'references'));
    fs.writeFileSync(path.join(source, 'references', 'config.md'), '# config\n');
  });
  afterEach(() => fs.rmSync(source, { recursive: true, force: true }));

  it('asks the library for what reaches every reader on the host, and keeps the other files beside SKILL.md', () => {
    const categories = vi.fn((..._askers: unknown[]) => cats({ ops: ['deploy-check'] }) as never);
    const r = renderBundledSkill(source, 'h1', ['codex', 'opencode'], { categories });
    expect(categories).toHaveBeenCalledWith({ host: 'h1', harness: 'codex' }, { host: 'h1', harness: 'opencode' });
    expect(r.key).toBe('codex+opencode');
    expect([...r.files.keys()]).toEqual(['SKILL.md', 'references/config.md']);
    expect(r.files.get('references/config.md')!.toString()).toBe('# config\n');
    expect(yamlOf(r.files.get('SKILL.md')!.toString()).description).toMatch(/In the library: ops: deploy-check\.$/);
    // The package's own file is never touched.
    expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(FOLDED);
  });

  it('has a digest that moves with the library line and only with it', () => {
    const lib = (named: Record<string, string[]>) => ({ categories: () => cats(named) as never });
    const a = renderBundledSkill(source, 'local', ['claude'], lib({ ops: ['a'] }));
    expect(renderBundledSkill(source, 'local', ['claude'], lib({ ops: ['a'] })).digest).toBe(a.digest);
    expect(renderBundledSkill(source, 'local', ['claude'], lib({ ops: ['a', 'b'] })).digest).not.toBe(a.digest);
  });

  it('ships the description as written when the library cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken = { categories: (): never => { throw new Error('EACCES'); } };
      expect(renderBundledSkill(source, 'local', ['claude'], broken).files.get('SKILL.md')!.toString()).toBe(FOLDED);
    } finally {
      warn.mockRestore();
    }
  });
});

/** A config directory of this test's own, holding the library the module-level reader sees. */
function useConfigDir(): { dir: () => string; add: (name: string, meta?: string) => void } {
  let dir = '';
  const saved = process.env.FLEETHERD_CONFIG_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-cfg-'));
    process.env.FLEETHERD_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FLEETHERD_CONFIG_DIR;
    else process.env.FLEETHERD_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir: () => dir,
    add: (name, meta = '') => {
      const d = skillDir(name, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: "Use when ${name}"\n${meta ? `metadata:\n${meta}` : ''}---\n\nbody\n`);
    },
  };
}

describe('the rendered copy on this machine (skill-link.ts placeRendered)', () => {
  const cfg = useConfigDir();
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-home-'));
    for (const d of ['.claude', '.codex', path.join('.config', 'opencode')]) fs.mkdirSync(path.join(home, d), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const source = bundledSkillDir();
  const shipped = fs.readFileSync(path.join(source, 'SKILL.md'));
  const quiet = <T>(run: () => T): { value: T; logged: string[] } => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      return { value: run(), logged: log.mock.calls.map((c) => String(c[0])) };
    } finally {
      log.mockRestore();
    }
  };

  it('is the package\'s skill, unchanged, with the references beside it, while the library is empty', () => {
    const claude = skillHomes('claude', home)[0]!;
    const copy = quiet(() => placeRendered(source, claude, home)).value;
    expect(copy).toBe(path.join(bundledSkillsHome(home), 'claude'));
    expect(fs.readFileSync(path.join(copy, 'SKILL.md')).equals(shipped)).toBe(true);
    expect(fs.existsSync(path.join(copy, 'references', 'config.md'))).toBe(true);
    expect(linkSkill(copy, claude).outcome).toBe('linked');
    expect(fs.readFileSync(path.join(claude.dir, 'fleetherd', 'SKILL.md')).equals(shipped)).toBe(true);
  });

  it('names the library, writes only when the line changes, and is one copy for codex and opencode', () => {
    cfg.add('deploy-check');
    cfg.add('agy-only', '  fleetherd-harnesses: "agy"\n');
    const [codex, opencode] = [skillHomes('codex', home)[0]!, skillHomes('opencode', home)[0]!];
    expect(skillReaders(codex.dir, home)).toEqual(['codex', 'opencode']);

    const first = quiet(() => placeRendered(source, codex, home));
    expect(first.value).toBe(path.join(bundledSkillsHome(home), 'codex+opencode'));
    expect(first.logged.some((l) => l.includes('wrote'))).toBe(true);
    const description = (): string => String(yamlOf(fs.readFileSync(path.join(first.value, 'SKILL.md'), 'utf8')).description);
    expect(description()).toMatch(/ In the library: other: deploy-check\.$/);

    // The other reader of that directory, and the same agent again: same copy, nothing written.
    const again = quiet(() => placeRendered(source, opencode, home));
    expect(again.value).toBe(first.value);
    expect(again.logged).toEqual([]);

    cfg.add('log-check');
    expect(quiet(() => placeRendered(source, codex, home)).logged.some((l) => l.includes('wrote'))).toBe(true);
    expect(description()).toMatch(/ In the library: other: deploy-check, log-check\.$/);
  });

  it('names only what reaches the host: a skill for another host stays out of the local copy', () => {
    cfg.add('elsewhere', '  fleetherd-hosts: "h2"\n');
    const copy = quiet(() => placeRendered(source, skillHomes('claude', home)[0]!, home)).value;
    expect(fs.readFileSync(path.join(copy, 'SKILL.md')).equals(shipped)).toBe(true);
  });
});

describe('the rendered copy on a host (bundledSkillProvision.remote)', () => {
  const cfg = useConfigDir();

  class FakeHost {
    readonly id = 'h1';
    readonly writes = new Map<string, string>();
    readonly links = new Map<string, string>();
    async writeFile(p: string, data: Uint8Array): Promise<void> {
      this.writes.set(p, Buffer.from(data).toString('utf8'));
    }
    async sweepSkillLinks(): Promise<string[]> {
      return [];
    }
    async ensureLink(target: string, link: string): Promise<{ outcome: string; link: string }> {
      this.links.set(link, target);
      return { outcome: 'linked', link };
    }
    async removeLink(link: string): Promise<{ outcome: string; link: string }> {
      return { outcome: 'skipped', link };
    }
  }

  const welcome: Welcome = { version: '9.0.0', instance: 'i1', home: '/home/u', pid: 1, os: 'linux', arch: 'amd64', resumed: false };
  const codex = { id: 'cx', harness: 'codex', host: 'h1', env: {} } as unknown as AgentDef;
  const base = '/home/u/.fleetherd/remote/9.0.0';
  const place = async (provision: ReturnType<typeof createBundledSkillProvision>, host: FakeHost, def = codex): Promise<void> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provision.remote(host as unknown as HostFiles, def, '/home/u', welcome);
    } finally {
      log.mockRestore();
    }
  };

  it('links the harness to a copy rendered for its directory, and super to the version\'s own files', async () => {
    cfg.add('deploy-check');
    cfg.add('elsewhere', '  fleetherd-hosts: "h2"\n');
    const [provision, host] = [createBundledSkillProvision(), new FakeHost()];
    await place(provision, host);
    expect(host.links.get('/home/u/.agents/skills/fleetherd')).toBe(`${base}/bundled/codex+opencode`);
    expect(host.links.get('/home/u/.agents/skills/super')).toBe(`${base}/skill-super`);
    expect(host.writes.has(`${base}/bundled/codex+opencode/references/config.md`)).toBe(true);
    expect([...host.writes.keys()].some((p) => p.startsWith(`${base}/skill/`))).toBe(false);
    const md = host.writes.get(`${base}/bundled/codex+opencode/SKILL.md`)!;
    // The host's own reach: a skill for h2 is not named on h1.
    expect(String(yamlOf(md).description)).toMatch(/ In the library: other: deploy-check\.$/);
  });

  it('sends the copy again only when the library line changed', async () => {
    cfg.add('deploy-check');
    const [provision, host] = [createBundledSkillProvision(), new FakeHost()];
    await place(provision, host);
    host.writes.clear();
    await place(provision, host);
    expect(host.writes.size).toBe(0);
    cfg.add('log-check');
    await place(provision, host);
    expect(String(yamlOf(host.writes.get(`${base}/bundled/codex+opencode/SKILL.md`)!).description)).toMatch(/deploy-check, log-check\.$/);
  });
});
