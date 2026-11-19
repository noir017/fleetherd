import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDef } from '../config/schema.js';
import type { InstructionsDelivery, InstructionsRefsResult } from '../platform/adapter.js';
import { buildInstructionsPanel, deliverInstructions, walkSources } from './instructions-panel.js';
import { harnessSources } from './instruction-imports.js';
import { HARNESS_LAYERS } from '../config/instructions.js';
import { INSTRUCTIONS_MAX_BYTES } from './instructions.js';
import { localWorkspace } from './workspace.js';

/**
 * The instruction editor's daemon side, against throwaway directories only: a gateway directory and
 * an agent's home made here, with the agent's machine handed in as a local Workspace on that home —
 * the same interface a remote host answers through (workspace.test.ts holds the two to it).
 */

let root: string;
let gateway: string;
let home: string;
let lines: string[];
let delivered: Array<Set<string>>;

const def = (id: string, harness: AgentDef['harness'], extra: Partial<AgentDef> = {}): AgentDef =>
  ({ id, harness, env: {}, args: [], ...extra }) as unknown as AgentDef;

const agents = [def('cc', 'claude'), def('cx', 'codex'), def('cc-r', 'claude', { host: 'box' })];

function panel(over: Partial<Parameters<typeof buildInstructionsPanel>[0]> = {}) {
  return buildInstructionsPanel({
    instance: 'web',
    agents: () => agents,
    dir: () => gateway,
    machine: async () => ({ ws: localWorkspace(home), home }),
    deliver: async (layers) => {
      delivered.push(new Set(layers));
      return [{ host: 'local', agents: ['cc'], outcome: 'linked', link: `${home}/.claude/CLAUDE.md` }];
    },
    log: (line) => lines.push(line),
    ...over,
  });
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** An agent's home as the gateway leaves it: CLAUDE.md a link to the delivered copy. */
function claudeHome(copy: string): void {
  fs.mkdirSync(path.join(home, '.fleetherd', 'instructions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.fleetherd', 'instructions', 'claude.md'), copy);
  fs.symlinkSync(path.join(home, '.fleetherd', 'instructions', 'claude.md'), path.join(home, '.claude', 'CLAUDE.md'));
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instr-panel-')));
  gateway = path.join(root, 'config', 'instructions');
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  lines = [];
  delivered = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the list', () => {
  it('lists common.md and each layer a configured agent reads, and says the directory is not there yet', async () => {
    const list = await panel().list();
    expect(list.on).toBe(false);
    expect(list.global.map((g) => [g.name, g.exists, g.agents])).toEqual([
      ['common.md', false, ['cc', 'cx', 'cc-r']],
      ['claude.md', false, ['cc', 'cc-r']],
      ['codex.md', false, ['cx']],
    ]);
    expect(list.agents).toEqual([
      { id: 'cc', harness: 'claude', host: 'local', file: '~/.claude/CLAUDE.md', own: expect.stringContaining('~/.claude/rules') },
      { id: 'cx', harness: 'codex', host: 'local', file: '~/.codex/AGENTS.md', own: expect.stringContaining('AGENTS.override.md') },
      { id: 'cc-r', harness: 'claude', host: 'box', file: '~/.claude/CLAUDE.md', own: expect.stringContaining('@') },
    ]);
  });

  it('keeps a layer nobody reads in the list once its file exists', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'agy.md'), 'old\n');
    const list = await panel().list();
    expect(list.on).toBe(true);
    expect(list.global.find((g) => g.name === 'agy.md')).toMatchObject({ exists: true, size: 4, agents: [] });
  });

  it('keeps the layer of an agent whose delivery is off, without counting it as a reader', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'cx2.md'), 'mine\n');
    const withOff = [
      ...agents,
      def('cx2', 'codex', { instructions: { file: '~/.codex/AGENTS.md', layer: 'cx2', off: true } }),
    ];
    const list = await panel({ agents: () => withOff }).list();
    expect(list.agents.find((a) => a.id === 'cx2')).toEqual({
      id: 'cx2',
      harness: 'codex',
      host: 'local',
      file: '~/.codex/AGENTS.md',
      own: expect.stringContaining('AGENTS.override.md'),
      notDelivered: true,
    });
    // The layer stays listed (and editable); the agent is not one of its readers.
    expect(list.global.find((g) => g.name === 'cx2.md')).toMatchObject({ exists: true, agents: [] });
    expect(list.global.find((g) => g.name === 'codex.md')?.agents).toEqual(['cx']);
    expect(list.global.find((g) => g.name === 'common.md')?.agents).toEqual(['cc', 'cx', 'cc-r']);
  });

  it('keeps a layer file on disk after its last agent is gone, and lets it be cleared', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'mh.md'), 'old\n');
    // Not layer files: another extension, an illegal name, a directory with the extension.
    fs.writeFileSync(path.join(gateway, 'mh.md.bak'), 'old\n');
    fs.writeFileSync(path.join(gateway, 'bad name.md'), 'x\n');
    fs.mkdirSync(path.join(gateway, 'dir.md'));
    const p = panel();
    const list = await p.list();
    expect(list.global.filter((g) => g.layer !== 'common').map((g) => [g.name, g.exists, g.agents, g.reach])).toEqual([
      ['claude.md', false, ['cc', 'cc-r'], 'every Claude Code agent'],
      ['codex.md', false, ['cx'], 'every Codex agent'],
      ['mh.md', true, [], 'the mh layer'],
    ]);
    expect(list.global.map((g) => g.name)).not.toContain('bad name.md');
    expect(list.global.map((g) => g.name)).not.toContain('dir.md');

    const read = await p.read({ scope: 'global', name: 'mh.md' });
    expect(read).toMatchObject({ ok: true, text: 'old\n', size: 4 });
    if (!read.ok) throw new Error(read.error);
    const cleared = await p.write({ scope: 'global', name: 'mh.md' }, '', { mtimeMs: read.mtimeMs, size: read.size, sha256: read.sha256 });
    expect(cleared).toMatchObject({ ok: true, size: 0 });
    expect(fs.readFileSync(path.join(gateway, 'mh.md'), 'utf8')).toBe('');
    // No configured agent reads it, so nothing was placed.
    expect(delivered).toEqual([new Set()]);
    // The fixed set still holds: a name neither configured nor on disk is refused.
    expect(await p.read({ scope: 'global', name: 'ghost.md' })).toMatchObject({ ok: false, error: expect.stringContaining('not one of') });
  });

  it('does not take a symlink in the directory as a layer of its own', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'not the gateway’s\n');
    fs.symlinkSync(outside, path.join(gateway, 'linked.md'));
    const p = panel();
    expect((await p.list()).global.map((g) => g.name)).not.toContain('linked.md');
    expect(await p.read({ scope: 'global', name: 'linked.md' })).toMatchObject({ ok: false, error: expect.stringContaining('not one of') });
    expect(await p.write({ scope: 'global', name: 'linked.md' }, 'x', { missing: true })).toMatchObject({ ok: false });
    expect(fs.readFileSync(outside, 'utf8')).toBe('not the gateway’s\n');
  });

  it('leaves a disk name that only differs in case from a known layer out of the list', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    for (const n of ['Common.md', 'Codex.md', 'Mine.md', 'Other.md']) fs.writeFileSync(path.join(gateway, n), 'x\n');
    const custom = [def('mh', 'custom', { command: 'h', instructions: { file: '~/f.md', layer: 'mine' } })];
    const p = panel({ agents: () => custom });
    const names = (await p.list()).global.map((g) => g.name);
    // The known spelling is what the list has; the differently-cased file is not another layer.
    expect(names).toEqual(expect.arrayContaining(['common.md', 'mine.md', 'Other.md']));
    for (const n of ['Common.md', 'Codex.md', 'Mine.md']) expect(names, n).not.toContain(n);
    // And it is not openable through the global route either.
    expect(await p.read({ scope: 'global', name: 'Common.md' })).toMatchObject({ ok: false, error: expect.stringContaining('not one of') });
  });

  it("lists a custom agent's layer by its id, and a pod agent's by the id in its pod.yaml", async () => {
    const custom = [
      def('mh', 'custom', { command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } }),
      def('mh@box', 'custom', {
        command: 'my-harness',
        host: 'box',
        instructions: { file: '~/.my-harness/AGENTS.md', layer: 'mh' },
      }),
    ];
    const list = await panel({ agents: () => custom }).list();
    expect(list.global).toEqual([
      { name: 'common.md', layer: 'common', exists: false, agents: ['mh', 'mh@box'], reach: 'every agent' },
      { name: 'mh.md', layer: 'mh', exists: false, agents: ['mh', 'mh@box'], reach: 'the mh layer' },
    ]);
    expect(list.agents).toEqual([
      { id: 'mh', harness: 'mh', host: 'local', file: '~/.my-harness/AGENTS.md' },
      { id: 'mh@box', harness: 'mh', host: 'box', file: '~/.my-harness/AGENTS.md' },
    ]);
  });
});

describe('who reads a layer', () => {
  it('names the kind of agent when only that kind reads it', async () => {
    const list = await panel().list();
    expect(list.global.map((g) => [g.layer, g.reach])).toEqual([
      ['common', 'every agent'],
      ['claude', 'every Claude Code agent'],
      ['codex', 'every Codex agent'],
    ]);
  });

  it('names the layer when an agent of another kind shares it', async () => {
    const shared = [def('cc', 'claude'), def('mh', 'custom', { command: 'h', instructions: { file: '~/f.md', layer: 'claude' } })];
    const list = await panel({ agents: () => shared }).list();
    expect(list.global.find((g) => g.layer === 'claude')).toMatchObject({ agents: ['cc', 'mh'], reach: 'the claude layer' });
  });

  it('does not say every Claude Code agent when one of them reads another layer', async () => {
    const split = [def('cc', 'claude'), def('cc2', 'claude', { instructions: { file: '~/f.md', layer: 'mine' } })];
    const list = await panel({ agents: () => split }).list();
    expect(list.global.find((g) => g.layer === 'claude')?.reach).toBe('the claude layer');
    expect(list.global.find((g) => g.layer === 'mine')?.reach).toBe('the mine layer');
  });

  it('does not count an agent whose delivery is off as a reader of its kind', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'mine.md'), 'mine\n');
    const withOff = [
      def('cc', 'claude'),
      def('cc2', 'claude', { instructions: { file: '~/.claude/CLAUDE.md', layer: 'mine', off: true } }),
    ];
    const list = await panel({ agents: () => withOff }).list();
    // cc2 is a Claude Code agent, but nothing reaches it, so claude.md still reaches every one that gets instructions.
    expect(list.global.find((g) => g.layer === 'claude')?.reach).toBe('every Claude Code agent');
    expect(list.global.find((g) => g.layer === 'mine')).toMatchObject({ agents: [], reach: 'the mine layer' });
  });

  it('names the layer for a file no agent reads', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'mh.md'), 'old\n');
    const list = await panel().list();
    expect(list.global.find((g) => g.layer === 'mh')).toMatchObject({ agents: [], reach: 'the mh layer' });
  });
});

describe('global files', () => {
  it('opens a file not written yet as empty, creates the directory and the file on save, and places it', async () => {
    const p = panel();
    const read = await p.read({ scope: 'global', name: 'common.md' });
    expect(read).toMatchObject({ ok: true, missing: true, kind: 'text', text: '' });

    const saved = await p.write({ scope: 'global', name: 'common.md' }, 'Answer in English.\n', { missing: true });
    expect(saved).toMatchObject({ ok: true, size: 19, sha256: sha('Answer in English.\n'), delivery: [{ outcome: 'linked' }] });
    expect(fs.readFileSync(path.join(gateway, 'common.md'), 'utf8')).toBe('Answer in English.\n');
    // common.md reaches every layer.
    expect([...(delivered[0] ?? [])].sort()).toEqual(['agy', 'atomcode', 'claude', 'codebuddy', 'codex', 'opencode']);
    expect(lines).toEqual([`[webui] instructions: owner@web wrote gateway:${path.join(gateway, 'common.md')} (19 bytes)`]);
  });

  it('places only the layer a per-harness file is for', async () => {
    await panel().write({ scope: 'global', name: 'claude.md' }, 'x\n', { missing: true });
    expect([...(delivered[0] ?? [])]).toEqual(['claude']);
  });

  it("writes and places a custom agent's layer, and common.md reaches it too", async () => {
    const custom = [def('mh', 'custom', { command: 'my-harness', instructions: { file: '~/.my-harness/AGENTS.md' } })];
    const p = panel({ agents: () => custom });
    expect(await p.read({ scope: 'global', name: 'mh.md' })).toMatchObject({ ok: true, missing: true });
    await p.write({ scope: 'global', name: 'mh.md' }, 'mine\n', { missing: true });
    expect([...(delivered[0] ?? [])]).toEqual(['mh']);
    await p.write({ scope: 'global', name: 'common.md' }, 'all\n', { missing: true });
    expect([...(delivered[1] ?? [])].sort()).toEqual(['agy', 'atomcode', 'claude', 'codebuddy', 'codex', 'mh', 'opencode']);
  });

  it('refuses a stale save as a conflict and writes nothing', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'codex.md'), 'theirs\n');
    const p = panel();
    const read = await p.read({ scope: 'global', name: 'codex.md' });
    if (!read.ok) throw new Error(read.error);
    fs.writeFileSync(path.join(gateway, 'codex.md'), 'changed!\n');
    const r = await p.write({ scope: 'global', name: 'codex.md' }, 'mine\n', { mtimeMs: read.mtimeMs, size: read.size, sha256: read.sha256 });
    expect(r).toMatchObject({ ok: false, conflict: true, exists: true });
    expect(fs.readFileSync(path.join(gateway, 'codex.md'), 'utf8')).toBe('changed!\n');
    expect(delivered).toEqual([]);
  });

  it('refuses a name outside the fixed set, so no path reaches the gateway', async () => {
    const p = panel();
    for (const name of ['../config.yaml', 'notes.md', 'common.md/../x', 'CLAUDE.md']) {
      expect(await p.read({ scope: 'global', name })).toMatchObject({ ok: false, error: expect.stringContaining('not one of') });
      expect(await p.write({ scope: 'global', name }, 'x', { missing: true })).toMatchObject({ ok: false });
    }
    expect(fs.existsSync(gateway)).toBe(false);
  });

  it('refuses a layer that is not a plain file name, even from an agent the schema never checked', async () => {
    // The config schema refuses this layer; a caller that never went through it must not be able
    // to turn `../escape` into a write outside the instructions directory.
    const bad = [def('x', 'custom', { command: 'h', instructions: { file: '~/f.md', layer: '../escape' } })];
    const p = panel({ agents: () => bad });
    for (const name of ['../escape.md', 'escape.md']) {
      expect(await p.read({ scope: 'global', name })).toMatchObject({ ok: false, error: expect.stringContaining('not one of') });
      expect(await p.write({ scope: 'global', name }, 'x', { missing: true })).toMatchObject({ ok: false });
    }
    expect(fs.existsSync(path.join(gateway, '..', 'escape.md'))).toBe(false);
    expect(fs.existsSync(path.join(gateway, 'escape.md'))).toBe(false);
    expect((await p.list()).global.map((g) => g.name)).not.toContain('../escape.md');
  });

  it('refuses a save that would put a layer over the cap, measured with what is already there', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'claude.md'), 'c'.repeat(INSTRUCTIONS_MAX_BYTES - 100));
    const r = await panel().write({ scope: 'global', name: 'common.md' }, 'x'.repeat(200), { missing: true });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/claude agents would be given \d+ bytes.*Nothing was saved/) });
    expect(fs.existsSync(path.join(gateway, 'common.md'))).toBe(false);
  });

  it('leaves a layer whose only agent has delivery off out of the cap, and still checks one that is read', async () => {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'cx2.md'), 'c'.repeat(INSTRUCTIONS_MAX_BYTES - 100));
    const at = (off: boolean): AgentDef =>
      def('cx2', 'codex', {
        instructions: off
          ? { file: '~/.codex/AGENTS.md', layer: 'cx2', off: true }
          : { file: '~/.codex/AGENTS.md', layer: 'cx2' },
      });
    const saved = await panel({ agents: () => [at(true)] }).write({ scope: 'global', name: 'common.md' }, 'x'.repeat(200), {
      missing: true,
    });
    expect(saved.ok).toBe(true);
    fs.rmSync(path.join(gateway, 'common.md'), { force: true });
    const refused = await panel({ agents: () => [at(false)] }).write({ scope: 'global', name: 'common.md' }, 'x'.repeat(200), {
      missing: true,
    });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/cx2 agents would be given \d+ bytes.*Nothing was saved/) });
  });
});

describe("an agent's references", () => {
  function layout(): void {
    claudeHome(
      [
        '# rules',
        '@~/.claude/rules.md',
        '@notes.md',
        '@~/.fleetherd/instructions/codex.md',
        '@~/missing/later.md',
        '@~/pic.png',
        '```',
        '@~/.claude/in-code.md',
        '```',
      ].join('\n')
    );
    fs.writeFileSync(path.join(home, '.claude', 'rules.md'), '@./more.md\n@~/.claude/rules.md\n');
    fs.writeFileSync(path.join(home, '.claude', 'more.md'), 'deep\n');
    fs.writeFileSync(path.join(home, '.fleetherd', 'instructions', 'codex.md'), 'a copy\n');
  }

  it('walks them as Claude Code does: through the link, relative to the real file, each once', async () => {
    layout();
    const r = (await panel().refs('cc')) as Extract<InstructionsRefsResult, { ok: true }>;
    expect(r).toMatchObject({ ok: true, host: 'local', rootState: 'managed', root: '~/.claude/CLAUDE.md' });
    // Depth first, as Claude Code reads them: rules.md's own reference comes right under it.
    expect(r.refs.map((x) => [x.shown, x.exists, x.depth, x.editable, x.kind])).toEqual([
      ['~/.claude/rules.md', true, 1, true, 'reference'],
      ['~/.claude/more.md', true, 2, true, 'reference'],
      // Relative to the delivered copy's directory, where the link leads — and not the copy itself.
      ['~/.fleetherd/instructions/notes.md', false, 1, true, 'reference'],
      ['~/.fleetherd/instructions/codex.md', true, 1, false, 'reference'],
      ['~/missing/later.md', false, 1, true, 'reference'],
    ]);
    expect(r.refs[1]?.via).toBe('~/.claude/rules.md');
    expect(r.refs.find((x) => x.shown.endsWith('codex.md'))?.note).toMatch(/gateway/);
  });

  it('says when the harness file is missing, and when it is the operator’s own', async () => {
    const src = harnessSources({ id: 'cc', harness: 'claude' }, home)!;
    expect(await walkSources(localWorkspace(home), src, home, HARNESS_LAYERS)).toEqual({ root: '~/.claude/CLAUDE.md', rootState: 'missing', summary: src.summary, refs: [] });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '@a.md\n');
    const w = await walkSources(localWorkspace(home), src, home, HARNESS_LAYERS);
    expect(w.rootState).toBe('own');
    expect(w.refs.map((x) => x.shown)).toEqual(['~/.claude/a.md']);
  });

  it('stops where Claude Code stops: five levels counting the first file', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '@l1.md\n');
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(home, '.claude', `l${i}.md`), `@l${i + 1}.md\n`);
    const r = (await panel().refs('cc')) as Extract<InstructionsRefsResult, { ok: true }>;
    expect(r.refs.map((x) => x.shown)).toEqual(['~/.claude/l1.md', '~/.claude/l2.md', '~/.claude/l3.md', '~/.claude/l4.md']);
  });

  it('reads and writes a referenced file where it is, keeping its version check, and logs the write', async () => {
    layout();
    const p = panel();
    const target = { scope: 'agent' as const, agent: 'cc', path: `${home}/.claude/rules.md` };
    const read = await p.read(target);
    if (!read.ok) throw new Error(read.error);
    expect(read).toMatchObject({ kind: 'text', rel: '~/.claude/rules.md' });
    const w = await p.write(target, 'new rules\n', { mtimeMs: read.mtimeMs, size: read.size, sha256: read.sha256 });
    expect(w).toMatchObject({ ok: true, size: 10 });
    expect(fs.readFileSync(path.join(home, '.claude', 'rules.md'), 'utf8')).toBe('new rules\n');
    expect(lines.at(-1)).toBe(`[webui] instructions: owner@web wrote local:${home}/.claude/rules.md (10 bytes, agent cc)`);
    // An agent's own file is not the gateway's to place anywhere.
    expect(delivered).toEqual([]);
  });

  it('creates a referenced file that is not there yet, with its directory', async () => {
    layout();
    const p = panel();
    const target = { scope: 'agent' as const, agent: 'cc', path: `${home}/missing/later.md` };
    expect(await p.read(target)).toMatchObject({ ok: true, missing: true, text: '' });
    expect(await p.write(target, 'later\n', { missing: true })).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(home, 'missing', 'later.md'), 'utf8')).toBe('later\n');
  });

  it('refuses any path the harness does not reference now, and the gateway’s own copy', async () => {
    layout();
    const p = panel();
    for (const bad of [`${home}/.bashrc`, `${home}/.claude/CLAUDE.md`, `${home}/.claude/in-code.md`, `${home}/pic.png`, '/etc/passwd']) {
      const r = await p.write({ scope: 'agent', agent: 'cc', path: bad }, 'x', { force: true });
      expect(r, bad).toMatchObject({ ok: false, error: expect.stringContaining("is not one of cc's instruction files") });
    }
    const copy = await p.write({ scope: 'agent', agent: 'cc', path: `${home}/.fleetherd/instructions/codex.md` }, 'x', { force: true });
    expect(copy).toMatchObject({ ok: false, error: expect.stringContaining("gateway's delivered copy") });
    expect(fs.readFileSync(path.join(home, '.fleetherd', 'instructions', 'codex.md'), 'utf8')).toBe('a copy\n');
    // A reference taken out since the list was drawn closes the file.
    fs.writeFileSync(path.join(home, '.fleetherd', 'instructions', 'claude.md'), 'nothing now\n');
    expect(await p.read({ scope: 'agent', agent: 'cc', path: `${home}/.claude/rules.md` })).toMatchObject({ ok: false });
  });

  it('names an agent that is not configured, or whose harness references nothing', async () => {
    const p = panel();
    expect(await p.refs('ghost')).toMatchObject({ ok: false, error: 'there is no agent "ghost" in the config' });
    const none = buildInstructionsPanel({ instance: 'web', agents: () => [def('ac', 'custom', { command: 'atomcode' })], machine: async () => ({ ws: localWorkspace(home), home }) });
    expect(await none.refs('ac')).toMatchObject({ ok: false, error: expect.stringContaining('no instruction files of its own') });
  });

  it('reports a machine that cannot be reached as the refusal it is', async () => {
    const p = panel({
      machine: async () => {
        throw new Error('no answer within 15 s');
      },
    });
    expect(await p.refs('cc-r')).toEqual({ ok: false, error: 'no answer within 15 s' });
  });
});

describe('each harness’s own files', () => {
  const walk = async (d: AgentDef) => {
    const src = harnessSources(d, home)!;
    const w = await walkSources(localWorkspace(home), src, home, HARNESS_LAYERS);
    return w.refs.map((x) => [x.shown, x.kind, x.depth, x.editable, x.note ?? '']);
  };
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };

  it('claude: the rules directory at any depth, each rule scanned for references too', async () => {
    claudeHome('@~/top.md\n');
    write('top.md', 'top\n');
    write('.claude/rules/b.md', '@./shared.md\n');
    write('.claude/rules/a/deep.md', 'deep\n');
    write('.claude/rules/shared.md', 'shared\n');
    write('.claude/rules/notes.txt', 'not markdown\n');
    expect(await walk(def('cc', 'claude'))).toEqual([
      ['~/top.md', 'reference', 1, true, ''],
      ['~/.claude/rules/a/deep.md', 'rule', 1, true, ''],
      ['~/.claude/rules/b.md', 'rule', 1, true, ''],
      // Listed once, under the rule that references it, not again as a rule of its own.
      ['~/.claude/rules/shared.md', 'reference', 2, true, ''],
    ]);
  });

  it('codebuddy: @path four hops deep, and its rules', async () => {
    write('.codebuddy/CODEBUDDY.md', '@n1.md\n');
    for (let i = 1; i <= 6; i++) write(`.codebuddy/n${i}.md`, `@n${i + 1}.md\n`);
    write('.codebuddy/rules/r.md', 'rule\n');
    expect((await walk(def('cb', 'custom', { command: 'codebuddy' }))).map((r) => r[0])).toEqual([
      '~/.codebuddy/n1.md',
      '~/.codebuddy/n2.md',
      '~/.codebuddy/n3.md',
      '~/.codebuddy/n4.md',
      '~/.codebuddy/rules/r.md',
    ]);
  });

  it('agy: its standalone files and rules, includes one level deep, and which rules wait to be chosen', async () => {
    fs.mkdirSync(path.join(home, '.fleetherd', 'instructions'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, '.fleetherd', 'instructions', 'agy.md'), '@[base](base.md)\n');
    fs.symlinkSync(path.join(home, '.fleetherd', 'instructions', 'agy.md'), path.join(home, '.gemini', 'config', 'AGENTS.md'));
    write('.gemini/base.md', '@[n2](never.md)\n');
    write('.gemini/GEMINI.md', 'mine\n');
    write('.gemini/config/rules/on.md', '---\ntrigger: always_on\n---\n@[x](x.md)\n');
    write('.gemini/config/rules/later.md', '---\ntrigger: model_decision\n---\n');
    expect(await walk(def('ag', 'agy'))).toEqual([
      // Relative to ~/.gemini, not to the copy the link leads to.
      ['~/.gemini/base.md', 'reference', 1, true, ''],
      ['~/.gemini/GEMINI.md', 'file', 1, true, ''],
      ['~/.gemini/config/rules/later.md', 'rule', 1, true, expect.stringContaining('always_on')],
      ['~/.gemini/config/rules/on.md', 'rule', 1, true, ''],
      ['~/.gemini/config/rules/x.md', 'reference', 2, true, ''],
    ]);
  });

  it('opencode: what its config lists — a path, a glob, a relative entry named but not opened, no URL', async () => {
    write('.config/opencode/opencode.jsonc', '{ // c\n "instructions": ["~/rules/a.md", "~/g/*.md", "CONTRIBUTING.md", "https://x/i.md", "~/missing.md"], }');
    write('rules/a.md', 'a\n');
    write('g/one.md', '1\n');
    write('g/two.md', '2\n');
    write('g/skip.txt', 'x\n');
    expect(await walk(def('oc', 'opencode'))).toEqual([
      ['~/rules/a.md', 'listed', 1, true, ''],
      ['~/g/one.md', 'listed', 1, true, ''],
      ['~/g/two.md', 'listed', 1, true, ''],
      ['CONTRIBUTING.md', 'listed', 1, false, expect.stringContaining('each conversation')],
      ['~/missing.md', 'listed', 1, true, ''],
    ]);
  });

  it('codex: AGENTS.override.md only when it exists, with what it does to the delivered file', async () => {
    expect(await walk(def('cx', 'codex'))).toEqual([]);
    write('.codex/AGENTS.override.md', 'mine\n');
    expect(await walk(def('cx', 'codex'))).toEqual([['~/.codex/AGENTS.override.md', 'file', 1, true, expect.stringContaining('instead of AGENTS.md')]]);
  });
});

describe('deliverInstructions', () => {
  it('places for every agent that reads the layers, names agents sharing a file together, and reports a host that did not answer', async () => {
    const all = [
      def('cc', 'claude'),
      def('cc2', 'claude'),
      def('cx', 'codex'),
      def('cr', 'claude', { host: 'box' }),
      def('cs', 'claude', { host: 'slow' }),
      def('g', 'gemini'),
    ];
    const local = vi.fn((d: AgentDef) => ({ link: `/h/.claude/CLAUDE.md`, outcome: d.id === 'cc' ? 'linked' : 'linked' }) as const);
    const remote = vi.fn(async (d: AgentDef) => {
      if (d.host === 'slow') return new Promise<never>(() => {});
      return { link: '/r/.claude/CLAUDE.md', outcome: 'relinked' as const, detail: 'old' };
    });
    const out: InstructionsDelivery[] = await deliverInstructions({ agents: all, layers: new Set(['claude']), local, remote, timeoutMs: 50 });
    expect(out).toEqual([
      { host: 'local', agents: ['cc', 'cc2'], link: '/h/.claude/CLAUDE.md', outcome: 'linked' },
      { host: 'box', agents: ['cr'], link: '/r/.claude/CLAUDE.md', outcome: 'relinked', detail: 'old' },
      { host: 'slow', agents: ['cs'], outcome: 'unreachable', detail: 'no answer within 0 s' },
    ]);
    // Codex reads another layer; gemini reads none.
    expect(local.mock.calls.map(([d]) => d.id)).toEqual(['cc', 'cc2']);
  });

  it('says so when placing is turned off rather than claiming it was placed', async () => {
    const out = await deliverInstructions({
      agents: [def('cc', 'claude')],
      layers: new Set(['claude']),
      local: () => undefined,
      remote: async () => undefined,
    });
    expect(out).toEqual([{ host: 'local', agents: ['cc'], outcome: 'off' }]);
  });

  it('reports an agent whose delivery is off as not delivered, and places nothing for it', async () => {
    const off = def('cc', 'claude', { instructions: { file: '~/.claude/CLAUDE.md', layer: 'cc', off: true } });
    const local = vi.fn(() => ({ link: '/h/.claude/CLAUDE.md', outcome: 'linked' as const }));
    const remote = vi.fn(async () => undefined);
    const out = await deliverInstructions({ agents: [off], layers: new Set(['cc']), local, remote });
    expect(out).toEqual([{ host: 'local', agents: ['cc'], outcome: 'not-delivered' }]);
    expect(local).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });
});
