import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { AgentDef } from '../config/schema.js';
import type {
  FilesPanelExpect,
  InstructionsAgent,
  InstructionsDelivery,
  InstructionsGlobalFile,
  InstructionsPanel,
  InstructionsPanelList,
  InstructionsReadResult,
  InstructionsRef,
  InstructionsRefsResult,
  InstructionsTarget,
  InstructionsWriteResult,
} from '../platform/adapter.js';
import { buildHarnessEnv, remoteAgentHome } from './agent-common.js';
import { MAX_EDIT_BYTES, readForEditor } from './file-panel.js';
import { globBase, globRegex, harnessSources, hasGlob, type HarnessSources } from './instruction-imports.js';
import {
  HARNESS_LAYERS,
  INSTRUCTIONS_MAX_BYTES,
  instructionsDir,
  instructionsHome,
  joinLayers,
  ownedDir,
  placeInstructions,
  readLayer,
  type HarnessLayer,
  type InstructionsResult,
} from './instructions.js';
import { remoteHosts } from './remote-hosts.js';
import { WorkspaceConflictError, localWorkspace, remoteWorkspace, type Workspace } from './workspace.js';

/**
 * The web UI's instruction editor: the operator's instructions, read and written from the settings
 * page, in the file window's editor (page.ts) and through the same checked write (`Workspace`).
 *
 * ── Two kinds of file ──────────────────────────────────────────────────────────────────────────
 *  - The gateway's own, in `<configDir>/instructions/` (instructions.ts): `common.md` and one file
 *    per harness layer. These are what the gateway composes and places on every machine. A save
 *    places the new text at once, on every machine an agent that reads it is configured for, and
 *    says where it landed — a host that cannot be reached gets it when an agent next starts there,
 *    as before.
 *  - An agent's own: the files its harness reads at user level besides the delivered one — rules,
 *    files the delivered one references, a config's list (instruction-imports.ts) — on the machine
 *    the agent runs on. The gateway does not manage these — the file on that machine
 *    is the truth, read and written where it is, and nothing is copied anywhere.
 *
 * ── Which paths ──────────────────────────────────────────────────────────────────────────────────
 * The page never names a path of its own. A global file is one of a fixed set of names. An agent's
 * file is a path the page got from `refs`, and every read and write walks the references again on
 * that machine and refuses a path that is not among them now: what a harness reads is the only
 * thing this route reaches, and a reference removed since the list was drawn closes it. The walk
 * is the harness's own rule; the gateway's delivered copies are listed, not editable here — they
 * are rewritten from the gateway's files, which are.
 *
 * Off unless `platforms.<id>.instructions.enabled` (AGENTS.md, invariant 10), and every write is
 * logged with who, which machine and which file.
 */

/** How long a save waits for one remote host before reporting it as not reached. */
export const DELIVER_TIMEOUT_MS = 10_000;
/** How long listing an agent's references waits for its host. */
const MACHINE_TIMEOUT_MS = 15_000;
/** The most files one walk lists; a reference loop is cut by `seen`, a huge tree by this. */
const REFS_MAX = 200;
/** How deep a rules directory or a glob's base is walked. */
const WALK_MAX_DEPTH = 8;

/** The machine an agent runs on, and the home it runs as there. */
export interface AgentMachine {
  ws: Workspace;
  home: string;
}

export interface InstructionsPanelOptions {
  /** The `platforms:` key this panel belongs to; named in the write log. */
  instance: string;
  /** The configured agents, read at every call (a `/reload` changes them). */
  agents: () => readonly AgentDef[];
  /** The gateway's instructions directory. */
  dir?: () => string;
  /** Reach the machine an agent runs on. Throws when it cannot be reached. */
  machine?: (def: AgentDef) => Promise<AgentMachine>;
  /** Place the composed text for `layers` on every machine now — see `deliverInstructions`. */
  deliver?: (layers: ReadonlySet<HarnessLayer>) => Promise<InstructionsDelivery[]>;
  log?: (line: string) => void;
}

/** A refusal the page shows as it is. */
class Refusal extends Error {}

export function buildInstructionsPanel(opts: InstructionsPanelOptions): InstructionsPanel {
  const env: Env = {
    instance: opts.instance,
    agents: opts.agents,
    dir: opts.dir ?? instructionsDir,
    machine: opts.machine ?? liveMachine,
    deliver: opts.deliver ?? ((layers) => liveDeliver(opts.agents(), layers)),
    log: opts.log ?? ((line: string) => console.log(line)),
  };
  return {
    list: () => listAll(env),
    refs: (agent) => refsOf(env, agent),
    read: (target, o) => readTarget(env, target, o?.preview === true),
    write: (target, text, expect) => writeTarget(env, target, text, expect),
  };
}

type Env = Required<Omit<InstructionsPanelOptions, 'instance'>> & { instance: string };

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

// ── the list ──────────────────────────────────────────────────────────────────────────────────

function globalNames(): string[] {
  return ['common.md', ...HARNESS_LAYERS.map((l) => `${l}.md`)];
}

async function listAll(env: Env): Promise<InstructionsPanelList> {
  const dir = env.dir();
  const agents = env.agents();
  const readers = new Map<string, string[]>();
  const everyone: string[] = [];
  const rows: InstructionsAgent[] = agents.map((def) => {
    // `~` as the home: the page shows where the file is on that machine, not this one's path to it.
    const where = instructionsHome(def.harness, '~', def.command);
    const own = harnessSources(def, '~')?.summary;
    if (where) {
      readers.set(where.name, [...(readers.get(where.name) ?? []), def.id]);
      everyone.push(def.id);
    }
    return {
      id: def.id,
      harness: def.harness === 'custom' && where ? where.name : def.harness,
      host: def.host ?? 'local',
      ...(where ? { file: where.file.split(path.sep).join('/') } : {}),
      ...(own ? { own } : {}),
    };
  });
  const global: InstructionsGlobalFile[] = [];
  for (const name of globalNames()) {
    const layer = name.slice(0, -'.md'.length);
    const st = statOrUndefined(path.join(dir, name));
    const agentsOf = layer === 'common' ? everyone : (readers.get(layer) ?? []);
    // A layer no configured agent reads, and nobody has written, is noise in the list.
    if (layer !== 'common' && !st && agentsOf.length === 0) continue;
    global.push({ name, layer, exists: Boolean(st), ...(st ? { size: st.size } : {}), agents: agentsOf });
  }
  return { dir, on: statOrUndefined(dir)?.isDirectory() === true, global, agents: rows };
}

function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

// ── an agent's own files ──────────────────────────────────────────────────────────────────────

interface Walk {
  root: string;
  rootState: 'managed' | 'own' | 'missing';
  summary: string;
  refs: InstructionsRef[];
}

function agentOf(env: Env, id: string): AgentDef {
  const def = env.agents().find((a) => a.id === id);
  if (!def) throw new Refusal(`there is no agent "${id}" in the config`);
  return def;
}

async function reach(env: Env, def: AgentDef): Promise<{ m: AgentMachine; src: HarnessSources }> {
  const m = await env.machine(def);
  const src = harnessSources(def, m.home);
  if (!src) throw new Refusal(`${def.id}'s harness has no instruction files of its own that this page knows`);
  return { m, src };
}

async function refsOf(env: Env, agent: string): Promise<InstructionsRefsResult> {
  try {
    const def = agentOf(env, agent);
    const { m, src } = await reach(env, def);
    const w = await walkSources(m.ws, src, m.home);
    return { ok: true, agent, host: m.ws.host, ...w };
  } catch (e) {
    return fail(e);
  }
}

/** What one walk carries between files: the machine, what is listed so far, and what has been seen. */
interface WalkState {
  ws: Workspace;
  home: string;
  src: HarnessSources;
  refs: InstructionsRef[];
  /** Paths and real paths already listed or scanned: a link and its target are one entry, a loop ends. */
  seen: Set<string>;
  /** The gateway's delivered copies on that machine, which are listed but never edited here. */
  copies: Set<string>;
}

/**
 * Every file of an agent's own instructions on its machine, as its harness finds them
 * (instruction-imports.ts `harnessSources`): the references in the delivered file, then each other
 * file the harness reads by itself and the references in it, then the files a config lists. Depth
 * first, in the order the harness reads them, each file once, and no further along a chain of
 * references than the harness goes.
 */
export async function walkSources(ws: Workspace, src: HarnessSources, home: string): Promise<Walk> {
  const P = path.posix;
  // The gateway's delivered copies — `<layer>.md` in its directory on that machine, under either
  // spelling of it — are what it rewrites at every start. Another file a person keeps beside them is
  // theirs, and editable like any other.
  const dirs = new Set([ownedDir(home), (await realpathOn(ws, ownedDir(home))) ?? ownedDir(home)]);
  const st: WalkState = {
    ws,
    home,
    src,
    refs: [],
    seen: new Set(),
    copies: new Set([...dirs].flatMap((d) => HARNESS_LAYERS.map((l) => P.join(d, `${l}.md`)))),
  };
  const realRoot = await realpathOn(ws, src.delivered);
  if (realRoot) {
    st.seen.add(src.delivered).add(realRoot);
    await scan(st, src.delivered, realRoot, 0, 1);
  }
  for (const f of src.files) await listFile(st, f.path, 1, 'file', () => f.note);
  for (const dir of src.ruleDirs) {
    for (const file of await markdownUnder(ws, dir)) await listFile(st, file, 1, 'rule', src.ruleNote);
  }
  if (src.lists) await listConfigured(st, src.lists);
  const rootState = !realRoot ? 'missing' : st.copies.has(realRoot) ? 'managed' : 'own';
  return { root: src.delivered, rootState, summary: src.summary, refs: st.refs };
}

/** One file the harness reads by itself: listed when it exists, then scanned for references. */
async function listFile(
  st: WalkState,
  file: string,
  depth: number,
  kind: InstructionsRef['kind'],
  noteOf?: (text: string) => string | undefined
): Promise<void> {
  if (st.seen.has(file) || st.refs.length >= REFS_MAX) return;
  const s = await st.ws.stat(file).catch(() => undefined);
  if (!s?.exists || s.dir) return;
  const real = (await realpathOn(st.ws, file)) ?? file;
  if (st.seen.has(real)) return;
  st.seen.add(file).add(real);
  const text = await readText(st.ws, real);
  const note = text === undefined ? undefined : noteOf?.(text);
  push(st, { path: file, real, exists: true, depth, kind, ...(note ? { note } : {}) });
  await scan(st, file, real, 0, depth + 1);
}

/** The references in one file, each listed, and followed while the harness would follow them. */
async function scan(st: WalkState, file: string, real: string, hop: number, depth: number): Promise<void> {
  const syntax = st.src.syntax;
  if (!syntax || hop >= syntax.hops) return;
  const text = await readText(st.ws, real);
  if (text === undefined) return;
  for (const ref of syntax.references(text)) {
    if (st.refs.length >= REFS_MAX) return;
    const abs = syntax.resolve(ref, { path: file, real }, st.home);
    if (!abs || st.seen.has(abs)) continue;
    st.seen.add(abs);
    const s = await st.ws.stat(abs).catch(() => ({ exists: false, dir: false }));
    const target = s.exists ? ((await realpathOn(st.ws, abs)) ?? abs) : abs;
    if (target !== abs && st.seen.has(target)) continue;
    st.seen.add(target);
    push(st, { path: abs, real: target, exists: s.exists, depth, kind: 'reference', dir: s.dir === true, via: file });
    if (s.exists && !s.dir) await scan(st, abs, target, hop + 1, depth + 1);
  }
}

/** The files a config lists (opencode's `instructions`): a path, a glob expanded, or a relative entry named. */
async function listConfigured(st: WalkState, lists: NonNullable<HarnessSources['lists']>): Promise<void> {
  const P = path.posix;
  for (const config of lists.configs) {
    const text = await readText(st.ws, config);
    if (text === undefined) continue;
    for (const entry of lists.entries(text)) {
      if (/^https?:\/\//i.test(entry)) continue; // fetched by the harness, not a file on the machine
      const abs = entry.startsWith('~/') ? P.join(st.home, entry.slice(2)) : P.isAbsolute(entry) ? P.normalize(entry) : undefined;
      if (!abs) {
        // A relative entry is looked up from each conversation's own directory upwards: there is no
        // one file to open from here.
        push(st, { path: entry, exists: false, depth: 1, kind: 'listed', fixed: 'relative: looked up from each conversation’s directory' });
        continue;
      }
      if (!hasGlob(abs)) {
        if (st.seen.has(abs)) continue;
        st.seen.add(abs);
        const s = await st.ws.stat(abs).catch(() => ({ exists: false, dir: false }));
        push(st, { path: abs, exists: s.exists, depth: 1, kind: 'listed', dir: s.dir === true });
        continue;
      }
      const re = globRegex(abs);
      for (const file of await filesUnder(st.ws, globBase(abs), () => true)) {
        if (re.test(file) && !st.seen.has(file)) {
          st.seen.add(file);
          push(st, { path: file, exists: true, depth: 1, kind: 'listed' });
        }
      }
    }
  }
}

/** One entry of the list, with what can be done with it decided here and nowhere else. */
function push(
  st: WalkState,
  e: { path: string; real?: string; exists: boolean; depth: number; kind: InstructionsRef['kind']; note?: string; dir?: boolean; via?: string; fixed?: string }
): void {
  const ours = st.copies.has(e.real ?? e.path);
  const why = e.fixed ?? (ours ? "the gateway's delivered copy: edit it under Every agent" : e.dir ? 'a directory, not a file' : undefined);
  const note = why ?? e.note;
  st.refs.push({
    path: e.path,
    shown: tilde(e.path, st.home),
    exists: e.exists,
    depth: e.depth,
    kind: e.kind,
    editable: why === undefined,
    ...(note ? { note } : {}),
    ...(e.via ? { via: tilde(e.via, st.home) } : {}),
  });
}

async function readText(ws: Workspace, p: string): Promise<string | undefined> {
  try {
    return (await ws.readFile(p, MAX_EDIT_BYTES)).toString('utf8');
  } catch {
    return undefined; // not there, unreadable, or too big for a harness to be reading it whole either
  }
}

/** The `.md` files under a rules directory, at any depth, in name order. */
function markdownUnder(ws: Workspace, dir: string): Promise<string[]> {
  return filesUnder(ws, dir, (name) => name.endsWith('.md'));
}

/** Files under `dir`, bounded like the file window's walk: a rules tree is small, a mistake is not. */
async function filesUnder(ws: Workspace, dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const P = path.posix;
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || out.length >= REFS_MAX) return;
    let entries: Array<{ name: string; dir: boolean }>;
    try {
      entries = await ws.listDir(d);
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const p = P.join(d, e.name);
      if (e.dir) await walk(p, depth + 1);
      else if (keep(e.name) && out.length < REFS_MAX) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

/** `p` after its symlinks, on the machine that has it; undefined when it is not there. */
async function realpathOn(ws: Workspace, p: string): Promise<string | undefined> {
  if (ws.host === 'local') return fs.promises.realpath(p).catch(() => undefined);
  const st = await ws.stat(p).catch(() => undefined);
  if (!st?.exists) return undefined;
  // The host has no realpath operation of its own (remote/ops.go); the coreutils one is on every
  // Linux and macOS host this runs agents on. Without it, the path as written is the best answer.
  const r = await ws.run(['realpath', '--', p]);
  const out = r.code === 0 && !r.spawnError ? r.output.toString('utf8').trim() : '';
  return out || p;
}

function tilde(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

/** The file a read or a write names, found again on the machine now — or a refusal. */
async function referenced(env: Env, agent: string, p: string): Promise<{ m: AgentMachine; ref: InstructionsRef }> {
  const def = agentOf(env, agent);
  const { m, src } = await reach(env, def);
  const w = await walkSources(m.ws, src, m.home);
  const ref = w.refs.find((r) => r.path === p);
  if (!ref) throw new Refusal(`${tilde(p, m.home)} is not one of ${agent}'s instruction files`);
  if (!ref.editable) throw new Refusal(`${ref.shown} is ${ref.note ?? 'not editable here'}`);
  return { m, ref };
}

// ── reads and writes ──────────────────────────────────────────────────────────────────────────

function globalFile(env: Env, name: string): string {
  if (!globalNames().includes(name)) throw new Refusal(`${name} is not one of the instruction files`);
  return path.join(env.dir(), name);
}

/** What the editor opens for a file a save would create: empty text, said to be missing. */
function missingFile(abs: string, P: typeof path.posix): InstructionsReadResult {
  return { ok: true, missing: true, path: abs, dir: P.dirname(abs), name: P.basename(abs), size: 0, mtimeMs: 0, kind: 'text', text: '', eol: 'lf' };
}

async function readTarget(env: Env, target: InstructionsTarget, preview: boolean): Promise<InstructionsReadResult> {
  try {
    if (target.scope === 'global') {
      const abs = globalFile(env, target.name);
      const ws = localWorkspace(env.dir());
      if (!(await ws.stat(abs)).exists) return missingFile(abs, path as typeof path.posix);
      return await readForEditor(ws, abs, { preview, shown: target.name });
    }
    const { m, ref } = await referenced(env, target.agent, target.path);
    if (!ref.exists) return missingFile(ref.path, path.posix);
    return await readForEditor(m.ws, ref.path, { preview, rel: ref.shown, shown: ref.shown });
  } catch (e) {
    return fail(e);
  }
}

async function writeTarget(env: Env, target: InstructionsTarget, text: string, expect: FilesPanelExpect): Promise<InstructionsWriteResult> {
  try {
    const data = Buffer.from(text, 'utf8');
    if (data.length > MAX_EDIT_BYTES) throw new Refusal(`that is ${data.length} bytes; the editor writes at most ${MAX_EDIT_BYTES}`);
    if (target.scope === 'global') return await writeGlobal(env, target.name, text, data, expect);
    const { m, ref } = await referenced(env, target.agent, target.path);
    // A referenced file that is not there yet is created where the reference says; its directory
    // too, since the reference is the operator's statement of where it belongs.
    if (!ref.exists && expect.missing) await m.ws.mkdirp(path.posix.dirname(ref.path));
    const out = await m.ws.writeFile(ref.path, data, expect);
    env.log(`[webui] instructions: owner@${env.instance} wrote ${m.ws.host}:${ref.path} (${data.length} bytes, agent ${target.agent})`);
    return { ok: true, mtimeMs: out.mtimeMs, size: out.size, sha256: sha(data) };
  } catch (e) {
    return conflictOr(e);
  }
}

async function writeGlobal(env: Env, name: string, text: string, data: Buffer, expect: FilesPanelExpect): Promise<InstructionsWriteResult> {
  const abs = globalFile(env, name);
  const dir = env.dir();
  const layers = affectedLayers(name);
  assertFits(dir, name, text, layers);
  // The directory is the feature's switch (instructions.ts): writing the first file into it is the
  // person turning it on, which is what they asked for by saving.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = await localWorkspace(dir).writeFile(abs, data, expect);
  env.log(`[webui] instructions: owner@${env.instance} wrote gateway:${abs} (${data.length} bytes)`);
  const delivery = await env.deliver(layers);
  return { ok: true, mtimeMs: out.mtimeMs, size: out.size, sha256: sha(data), delivery };
}

/** The layers a change to `name` reaches: every one for `common.md`, its own otherwise. */
function affectedLayers(name: string): Set<HarnessLayer> {
  const layer = name.slice(0, -'.md'.length);
  return new Set(HARNESS_LAYERS.filter((l) => name === 'common.md' || l === layer));
}

/**
 * Refuse a save that would put any agent over the cap, before it is written. Delivery would refuse
 * it anyway (instructions.ts), but only into a log line; here the person who caused it is looking.
 */
function assertFits(dir: string, name: string, text: string, layers: ReadonlySet<HarnessLayer>): void {
  const layerText = (file: string): string | undefined => (file === name ? text : readLayer(dir, file));
  for (const l of layers) {
    const composed = joinLayers([layerText('common.md'), layerText(`${l}.md`)]);
    if (composed.kind === 'too-big') {
      throw new Refusal(
        `with this text, ${l} agents would be given ${composed.bytes} bytes — over the ${INSTRUCTIONS_MAX_BYTES}-byte limit, ` +
          'and nothing over it is delivered. Nothing was saved.'
      );
    }
  }
}

function conflictOr(e: unknown): InstructionsWriteResult {
  if (e instanceof WorkspaceConflictError) {
    return {
      ok: false,
      conflict: true,
      exists: e.exists,
      ...(e.size !== undefined ? { size: e.size } : {}),
      ...(e.mtimeMs !== undefined ? { mtimeMs: e.mtimeMs } : {}),
      error: e.exists ? 'The file changed since it was opened.' : 'The file is gone.',
    };
  }
  return fail(e);
}

function sha(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ── delivery ──────────────────────────────────────────────────────────────────────────────────

/**
 * Place the composed text for `layers` for every configured agent that reads one of them, now, and
 * say what each placement came to — one line per machine and file, the agents that share it named
 * together. The placing is instructions.ts's and remote-hosts.ts's, unchanged: the same rules about
 * what is never overwritten, the same log lines. A remote host that does not answer within
 * `timeoutMs` is reported as not reached; the next agent start there places the text, as it always
 * did.
 */
export async function deliverInstructions(o: {
  agents: readonly AgentDef[];
  layers: ReadonlySet<HarnessLayer>;
  local: (def: AgentDef) => InstructionsResult | undefined;
  remote: (def: AgentDef) => Promise<InstructionsResult | undefined>;
  timeoutMs?: number;
}): Promise<InstructionsDelivery[]> {
  const out = new Map<string, InstructionsDelivery>();
  const add = (host: string, agent: string, r: { link?: string; outcome: string; detail?: string }): void => {
    const k = `${host}\u0000${r.link ?? ''}\u0000${r.outcome}`;
    const known = out.get(k);
    if (known) known.agents.push(agent);
    else out.set(k, { host, agents: [agent], ...(r.link ? { link: r.link } : {}), outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) });
  };
  const readers = o.agents.filter((def) => {
    const where = instructionsHome(def.harness, '~', def.command);
    return where !== undefined && o.layers.has(where.name);
  });
  const remote = readers.filter((def) => def.host);
  for (const def of readers.filter((d) => !d.host)) {
    add('local', def.id, o.local(def) ?? { outcome: 'off' });
  }
  const settled = await Promise.allSettled(remote.map((def) => withTimeout(o.remote(def), o.timeoutMs ?? DELIVER_TIMEOUT_MS)));
  settled.forEach((s, i) => {
    const def = remote[i] as AgentDef;
    if (s.status === 'fulfilled') add(def.host as string, def.id, s.value ?? { outcome: 'off' });
    else add(def.host as string, def.id, { outcome: 'unreachable', detail: s.reason instanceof Error ? s.reason.message : String(s.reason) });
  });
  return [...out.values()];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// ── the live daemon's machines ────────────────────────────────────────────────────────────────

/** The home a local agent runs as: an `env.HOME` override, else this account's (agent-common.ts). */
function localHome(def: AgentDef): string {
  return buildHarnessEnv(def).HOME || homedir();
}

async function liveMachine(def: AgentDef): Promise<AgentMachine> {
  if (!def.host) {
    const home = localHome(def);
    return { ws: localWorkspace(home), home };
  }
  const host = remoteHosts.hostFor(def);
  if (!host) throw new Refusal(`host "${def.host}" is not configured`);
  const w = await withTimeout(host.ready(), MACHINE_TIMEOUT_MS);
  const home = remoteAgentHome(def, w);
  return { ws: remoteWorkspace(host, home), home };
}

function liveDeliver(agents: readonly AgentDef[], layers: ReadonlySet<HarnessLayer>): Promise<InstructionsDelivery[]> {
  return deliverInstructions({
    agents,
    layers,
    local: (def) => placeInstructions(def, localHome(def)),
    remote: async (def) => {
      const host = remoteHosts.hostFor(def);
      if (!host) throw new Error(`host "${def.host}" is not configured`);
      const w = await host.ready();
      return remoteHosts.placeInstructions(host, def, remoteAgentHome(def, w), w);
    },
  });
}
