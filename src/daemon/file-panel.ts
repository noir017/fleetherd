/**
 * The web UI's file window: the files of whichever machine a topic's agent runs on, and the
 * writes an editor needs.
 *
 * ── One window, two machines ─────────────────────────────────────────────────
 * A topic's files are wherever its agent is — this machine on a default install, a remote host
 * when the agent was moved there. `ConversationRegistry.workspaceForRef` already answers that with
 * the same interface on both (workspace.ts), so nothing here knows which one it is talking to.
 *
 * ── What may be touched ─────────────────────────────────────────────────────
 * The topic's working directory, plus `platforms.<id>.files.roots` for directories the operator
 * wants reachable from every topic. Containment is decided on the PATH ITSELF: normalize it, then
 * require it to sit under one of those roots. A `..` that climbs out is refused, not clamped.
 *
 * Symlinks are followed, and deliberately not resolved for that check. A workspace laid out as
 * links into mounted volumes is a normal arrangement (workdir-scan.ts says so too), and a rule
 * that resolved every link would refuse to edit the very files the person opened the window for.
 * The cost is stated where the operator reads it: whatever a link inside a root points at is
 * writable through it. The ceiling is the agent's own — it already runs with full tool access on
 * that machine — and the terminal, which this feature is the sibling of.
 *
 * ── Why the write is not `workspace.writeFile` of the host's own ────────────
 * Because the editor is not the gateway writing its own file: the person may be editing something
 * an agent is editing too. `Workspace.writeFile` is exactly the checked, link-following,
 * mode-preserving write that needs (see its comment), and both machines implement it alike.
 *
 * ── Bytes, kept as they were ────────────────────────────────────────────────
 * A save must not change what the person did not edit. A UTF-8 BOM is decoded into the text
 * (`ignoreBOM: true`, so it is not eaten) and written back with it; the file's line ending is
 * reported as `eol`, because a textarea normalizes CRLF to LF and the page puts it back before
 * sending. The version a save carries is the size, mtime and SHA-256 the page read.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConversationRef } from '../core/conversation.js';
import type {
  FileGitStatus,
  FilesPanel,
  FilesPanelConflict,
  FilesPanelCreateResult,
  FilesPanelEntry,
  FilesPanelFile,
  FilesPanelHit,
  FilesPanelListResult,
  FilesPanelReadResult,
  FilesPanelRemoveResult,
  FilesPanelRenameResult,
  FilesPanelSearchResult,
  FilesPanelWriteResult,
} from '../platform/workbench.js';
import { renderWebMarkdown } from '../platform/web-markdown.js';
import { WorkspaceConflictError, type Workspace } from './workspace.js';

/** A file larger than this is shown with its details and no editor. */
export const MAX_EDIT_BYTES = 1 << 20;
/** An image larger than this is not turned into a data: URL — the answer would dwarf the page. */
export const MAX_IMAGE_BYTES = 5 << 20;
/** A search answer carries at most this many hits; more is said to exist. */
export const SEARCH_MAX = 200;
/** The bounded walk's own ceilings, for a directory that is not a git repository. */
const WALK_MAX_DEPTH = 10;
const WALK_MAX_DIRS = 2_000;
const WALK_MAX_ENTRIES = 20_000;
/** Entries the walk never descends into: build output and dependency trees, never the file sought. */
const WALK_SKIP = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.tox',
]);

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const MARKDOWN = /\.(md|markdown)$/i;
const BOM = '\uFEFF';

export interface FilesPanelOptions {
  /** The `platforms:` key this panel belongs to; named in the write log. */
  instance: string;
  /** Directories reachable besides each topic's working directory. */
  roots: readonly string[];
  /** The daemon's answer to "where does this conversation's agent run", or undefined when unknown. */
  workspaceForRef: (ref: ConversationRef) => Workspace | undefined;
  /** Where a write is recorded. The daemon's console by default. */
  log?: (line: string) => void;
}

/** One resolved path: where it is, which root allows it, and how the page should name it. */
interface Located {
  abs: string;
  /** Relative to the workspace root; undefined for a path inside an extra root. */
  rel?: string;
  /** The root that contains it — what rename/remove are fenced by. */
  root: string;
}

/** The roots one workspace may touch, the working directory first, and the machine's home. */
interface Roots {
  roots: string[];
  home: string;
  repo?: string;
}

/** Everything the panel's operations share; built once per `buildFilesPanel`. */
interface PanelEnv {
  instance: string;
  log: (line: string) => void;
  extraRoots: readonly string[];
  /** Resolved roots per workspace. A rejected promise is removed again — see `rootsOf`. */
  resolved: Map<string, Promise<Roots>>;
  workspaceForRef: (ref: ConversationRef) => Workspace | undefined;
}

/** A refusal the page shows as a sentence, rather than a stack from inside the daemon. */
class FilesRefusal extends Error {}

export function buildFilesPanel(opts: FilesPanelOptions): FilesPanel {
  const env: PanelEnv = {
    instance: opts.instance,
    log: opts.log ?? ((line: string) => console.log(line)),
    extraRoots: opts.roots,
    resolved: new Map(),
    workspaceForRef: opts.workspaceForRef,
  };
  return {
    list: (ref, p) => panelList(env, ref, p),
    read: (ref, p, o) => panelRead(env, ref, p, o),
    write: (ref, p, text, expect) => panelWrite(env, ref, p, text, expect),
    create: (ref, p, dir) => panelCreate(env, ref, p, dir),
    rename: (ref, from, to) => panelRename(env, ref, from, to),
    remove: (ref, p) => panelRemove(env, ref, p),
    search: (ref, q) => panelSearch(env, ref, q),
  };
}

function need(env: PanelEnv, ref: ConversationRef): Workspace {
  const ws = env.workspaceForRef(ref);
  if (!ws) throw new FilesRefusal('this topic has no workspace: its agent is not in the config any more');
  return ws;
}

function key(ws: Workspace): string {
  return `${ws.host}\u0000${ws.root}`;
}

/**
 * The roots this workspace may touch, absolute and normalized, the working directory first.
 *
 * The working directory is asked of the machine rather than assumed to be absolute: a remote
 * agent's `cwd` may be written `~/work`, and the host expands that only when it reads a path.
 * `pwd` gives the answer once per workspace and is cached with it.
 */
function rootsOf(env: PanelEnv, ws: Workspace): Promise<Roots> {
  const k = key(ws);
  const known = env.resolved.get(k);
  if (known) return known;
  const made = resolveRoots(env, ws);
  env.resolved.set(k, made);
  // A failure is not a fact about the machine. Caching a rejected promise would close this
  // host-and-root combination until a restart after one dropped `pwd`; forget it and let the next
  // open ask again.
  made.catch(() => {
    if (env.resolved.get(k) === made) env.resolved.delete(k);
  });
  return made;
}

async function resolveRoots(env: PanelEnv, ws: Workspace): Promise<Roots> {
  const P = sep(ws);
  let base: string;
  let home: string;
  if (ws.host === 'local') {
    home = os.homedir();
    base = await fs.promises.realpath(ws.root).catch(() => P.resolve(ws.root));
  } else {
    const r = await ws.run(['pwd']);
    const h = await ws.run(['printenv', 'HOME']);
    // Checked, not best-effort: an unread HOME would silently leave every `~/…` root unresolved
    // (containment compares absolute paths), and the window would look empty for no stated reason.
    home = h.code === 0 && !h.spawnError ? h.output.toString('utf8').trim() : '';
    base = r.output.toString('utf8').trim();
    if (r.spawnError || r.code !== 0 || !base) {
      throw new FilesRefusal(`could not find this topic's working directory on ${ws.host}`);
    }
  }
  base = P.normalize(base);
  const roots = [base];
  // The repository the working directory sits in. A git panel names a file from the REPO root, so
  // a topic working in a subdirectory (`repo/apps/web`) has to reach `repo/packages/…` too. Not a
  // configured scope: it is the project the person is already in, and it is only as wide as the
  // checkout. A lookup that did not answer (timeout) is not cached as "no repository here".
  const repo = await repoRoot(ws, base);
  if (repo && !roots.includes(repo)) roots.push(repo);
  for (const raw of env.extraRoots) {
    const wantsHome = raw === '~' || raw.startsWith('~/');
    if (wantsHome && !home) {
      throw new FilesRefusal(`cannot resolve ${raw}: the home directory is not readable on ${ws.host}`);
    }
    const abs = P.normalize(expandHome(raw, home, P));
    if (!roots.includes(abs)) roots.push(abs);
  }
  return { roots, home, ...(repo ? { repo } : {}) };
}

/**
 * The root of the git repository `base` is in, asked of the machine that has the files.
 *
 * Undefined for a directory that is not a repository, and for a machine where git is not installed
 * (`spawnError`): neither is a reason to refuse the window. A timeout IS a failure to answer, and
 * throws so `rootsOf` does not keep a rootless answer — the next open asks again.
 */
async function repoRoot(ws: Workspace, base: string): Promise<string | undefined> {
  const r = await ws.run(['git', '-C', base, 'rev-parse', '--show-toplevel']);
  if (r.spawnError || r.code !== 0) {
    if (r.timedOut) throw new FilesRefusal(`git did not answer on ${ws.host}; try opening the file again`);
    return undefined;
  }
  const P = sep(ws);
  const top = P.normalize(r.output.toString('utf8').trim());
  return top && P.isAbsolute(top) ? top : undefined;
}

/**
 * One path from the page, resolved against the roots.
 *
 * Absolute or relative, it is normalized and then tested for containment — never clamped: a path
 * that normalizes outside every root is refused with the sentence the page shows. A relative path
 * resolves against the topic's working directory, which is what `openFileEditor(path)` means.
 */
async function locate(env: PanelEnv, ws: Workspace, input: string): Promise<Located> {
  const P = sep(ws);
  const { roots, home } = await rootsOf(env, ws);
  const fromRoot = roots[0] as string;
  const raw = (input ?? '').trim() || '.';
  // `~` is not absolute to a path library; expanding it here is what makes a root or a link the
  // operator wrote in config.yaml usable. Anything else starting with `~` is refused below by
  // containment, since it lands under the working directory as a literal name.
  const expanded = raw === '~' || raw.startsWith('~/') ? expandHome(raw, home, P) : raw;
  const normalized = P.normalize(expanded);
  if (normalized === '..' || normalized.startsWith(`..${P.sep}`)) {
    throw new FilesRefusal(`${raw} climbs out of the workspace`);
  }
  const abs = P.normalize(
    P.isAbsolute(normalized) ? normalized : P.join(fromRoot, normalized === '.' ? '' : normalized)
  );
  const root = roots.find((r) => abs === r || abs.startsWith(r + P.sep));
  if (!root) throw new FilesRefusal(`${raw} is outside this topic's workspace`);
  const rel = abs === fromRoot ? '' : abs.startsWith(fromRoot + P.sep) ? abs.slice(fromRoot.length + 1) : undefined;
  return { abs, rel, root };
}

function where(at: Located): string {
  return at.rel === undefined ? at.abs : at.rel || '.';
}

function logWrite(env: PanelEnv, ws: Workspace, what: string, at: Located, extra = ''): void {
  // Who: the web UI has one identity, the operator the session cookie belongs to. Which machine:
  // the workspace's host, because the same relative path means different files on two of them.
  env.log(`[webui] files: owner@${env.instance} ${what} ${ws.host}:${at.abs}${extra}`);
}

function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof FilesRefusal) return { ok: false, error: e.message };
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}



// ── the operations ───────────────────────────────────────────────────────────────────────────

async function panelList(env: PanelEnv, ref: ConversationRef, input: string): Promise<FilesPanelListResult> {
  try {
    const ws = need(env, ref);
    const at = await locate(env, ws, input);
    const entries = await ws.listDir(at.abs);
    const sorted = [...entries].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const statuses = await gitStatusForDir(env, ws, at.abs);
    const annotated: FilesPanelEntry[] =
      statuses.size > 0
        ? sorted.map((e) => {
            const gitStatus = statuses.get(e.name);
            return gitStatus ? { ...e, gitStatus } : e;
          })
        : sorted;
    return { ok: true, path: at.abs, ...(at.rel !== undefined ? { rel: at.rel } : {}), entries: annotated };
  } catch (e) {
    return fail(e);
  }
}

const GIT_STATUS_PRIORITY: Readonly<Record<FileGitStatus, number>> = {
  U: 6,
  M: 5,
  A: 4,
  R: 3,
  D: 2,
  '?': 1,
};

function mapPorcelainStatus(xy: string): FileGitStatus {
  if (xy === '??') return '?';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'U';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  if (xy.includes('A')) return 'A';
  if (xy.includes('D')) return 'D';
  return 'M';
}

/** Parse `git status --porcelain=v1 -z` output into direct child entry badges under `prefix`. */
export function parseDirGitStatus(text: string, prefix: string): Map<string, FileGitStatus> {
  const out = new Map<string, FileGitStatus>();
  const pfx = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const rel = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i += 1;
    if (pfx && !rel.startsWith(pfx)) continue;
    const sub = (pfx ? rel.slice(pfx.length) : rel).replace(/\/+$/, '');
    if (!sub) continue;
    const slash = sub.indexOf('/');
    const name = slash >= 0 ? sub.slice(0, slash) : sub;
    const badge = mapPorcelainStatus(xy);
    const prev = out.get(name);
    if (!prev || GIT_STATUS_PRIORITY[badge] > GIT_STATUS_PRIORITY[prev]) out.set(name, badge);
  }
  return out;
}

/** Best-effort read-only git status for one already-located directory (invariant 9). */
async function gitStatusForDir(env: PanelEnv, ws: Workspace, dir: string): Promise<Map<string, FileGitStatus>> {
  try {
    const { repo } = await rootsOf(env, ws);
    if (!repo) return new Map();
    const P = sep(ws);
    if (dir !== repo && !dir.startsWith(repo + P.sep)) return new Map();
    const prefix = dir === repo ? '' : `${dir.slice(repo.length + 1).replace(/\\/g, '/')}/`;
    const r = await ws.run(
      ['git', '-C', repo, '--literal-pathspecs', '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', prefix || '.'],
      { env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, maxBytes: 2 << 20 }
    );
    if (r.spawnError || r.timedOut || r.code !== 0 || r.truncated) return new Map();
    return parseDirGitStatus(r.output.toString('utf8'), prefix);
  } catch {
    return new Map();
  }
}

async function panelRead(
  env: PanelEnv,
  ref: ConversationRef,
  input: string,
  o: { preview?: boolean } = {}
): Promise<FilesPanelReadResult> {
  try {
    const ws = need(env, ref);
    const at = await locate(env, ws, input);
    return await readForEditor(ws, at.abs, { rel: at.rel, preview: o.preview, shown: where(at) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * One file as the editor gets it: text with its version, or what it is instead (image, binary, too
 * big). The read half of the window, after the path has been allowed — exported for the other caller
 * that decides its own paths (instructions-panel.ts) and must hand the page the same answer.
 * `shown` is how a refusal names the file. Throws for a missing file or a directory.
 */
export async function readForEditor(
  ws: Workspace,
  abs: string,
  o: { rel?: string; preview?: boolean; shown?: string } = {}
): Promise<FilesPanelReadResult> {
  const shown = o.shown ?? abs;
  const st = await ws.stat(abs);
  if (!st.exists) throw new FilesRefusal(`${shown} does not exist`);
  if (st.dir) throw new FilesRefusal(`${shown} is a directory`);
  const base: Omit<FilesPanelFile, 'kind'> = {
    path: abs,
    dir: sep(ws).dirname(abs),
    ...(o.rel !== undefined ? { rel: o.rel } : {}),
    name: sep(ws).basename(abs),
    size: st.size ?? 0,
    mtimeMs: st.mtimeMs ?? 0,
  };
  const image = IMAGE_TYPES[extOf(base.name)];
  if (image) return await readImage(ws, abs, base, image);
  if (base.size > MAX_EDIT_BYTES) {
    return {
      ok: true,
      ...base,
      kind: 'big',
      note: `Too large to edit here (${byteText(base.size)}, over ${byteText(MAX_EDIT_BYTES)}). It can still be read and changed on that machine.`,
    };
  }
  const bytes = await ws.readFile(abs, MAX_EDIT_BYTES);
  return decodeRead(base, bytes, o.preview === true);
}

async function readImage(
  ws: Workspace,
  abs: string,
  base: Omit<FilesPanelFile, 'kind'>,
  mime: string
): Promise<FilesPanelReadResult> {
  if (base.size > MAX_IMAGE_BYTES) {
    return {
      ok: true,
      ...base,
      kind: 'big',
      note: `Too large to preview (${byteText(base.size)}, over ${byteText(MAX_IMAGE_BYTES)}).`,
    };
  }
  const bytes = await ws.readFile(abs, MAX_IMAGE_BYTES);
  return { ok: true, ...base, kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}

/**
 * What a file's bytes are to an editor: text (with the version and the facts a save needs to put
 * it back byte for byte), or the reason it is shown and not edited.
 */
function decodeRead(
  base: Omit<FilesPanelFile, 'kind'>,
  bytes: Buffer,
  preview: boolean
): FilesPanelReadResult {
  // A NUL byte in the first block is the same test `file` uses for "binary", and it is the one
  // that keeps a PNG without an extension from filling an editor with mojibake.
  if (bytes.includes(0)) {
    return { ok: true, ...base, kind: 'binary', note: 'Binary file: shown for its details, not edited.' };
  }
  let text: string;
  try {
    // ignoreBOM: true means "do not treat the BOM specially" — it stays in the string, and so in
    // the bytes written back. Without it a save would silently drop a byte the person never saw.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: true, ...base, kind: 'binary', note: 'Not valid UTF-8: shown for its details, not edited.' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const bom = text.startsWith(BOM);
  // The page puts this back before saving: a textarea hands back LF whatever was in it.
  const { eol, warning } = lineEndings(text);
  // Rendered without the BOM, which is not part of the first line's markdown.
  const html = preview && MARKDOWN.test(base.name) ? renderWebMarkdown(bom ? text.slice(1) : text) : undefined;
  return {
    ok: true,
    ...base,
    kind: 'text',
    text,
    sha256,
    eol,
    ...(warning ? { eolWarning: warning } : {}),
    ...(bom ? { bom: true } : {}),
    ...(html !== undefined ? { html } : {}),
  };
}

/**
 * The line ending a save will write, and whether that is a change to what is there.
 *
 * Uniform LF and uniform CRLF are byte-exact through a save. Anything else — mixed endings, or a
 * file that uses only CR, which the editor cannot even hold (a textarea normalizes every ending to
 * LF) — is normalized to one ending, and `warning` is what makes the page say so above the editor
 * rather than changing the file behind the person's back.
 */
export function lineEndings(text: string): { eol: 'crlf' | 'lf'; warning?: 'mixed' | 'cr' } {
  const { crlf, lf, cr, first } = countEndings(text);
  if (crlf > 0 && lf === 0 && cr === 0) return { eol: 'crlf' };
  if (lf > 0 && crlf === 0 && cr === 0) return { eol: 'lf' };
  // Only CR breaks: nothing an editor can hold. A file with no breaks at all is just LF-shaped.
  if (crlf === 0 && lf === 0) return cr > 0 ? { eol: 'lf', warning: 'cr' } : { eol: 'lf' };
  // Mixed. The ending of the FIRST break wins a tie, which is what a person reading the top of
  // the file sees; with more of one than the other, the majority wins.
  const eol = crlf > lf ? 'crlf' : lf > crlf ? 'lf' : first === 'crlf' ? 'crlf' : 'lf';
  return { eol, warning: 'mixed' };
}

/** How many CRLF, LF and lone-CR breaks a text has, and which kind comes first. */
function countEndings(text: string): { crlf: number; lf: number; cr: number; first?: 'crlf' | 'lf' | 'cr' } {
  const counts: { crlf: number; lf: number; cr: number; first?: 'crlf' | 'lf' | 'cr' } = { crlf: 0, lf: 0, cr: 0 };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\r' && ch !== '\n') continue;
    const kind = ch === '\n' ? 'lf' : text[i + 1] === '\n' ? 'crlf' : 'cr';
    if (kind === 'crlf') i += 1;
    counts[kind] += 1;
    if (!counts.first) counts.first = kind;
  }
  return counts;
}

async function panelWrite(
  env: PanelEnv,
  ref: ConversationRef,
  input: string,
  text: string,
  expect: { mtimeMs?: number; size?: number; sha256?: string; missing?: boolean; force?: boolean }
): Promise<FilesPanelWriteResult> {
  try {
    const ws = need(env, ref);
    const at = await locate(env, ws, input);
    const data = Buffer.from(text, 'utf8');
    if (data.length > MAX_EDIT_BYTES) {
      throw new FilesRefusal(`that is ${byteText(data.length)}; the editor writes at most ${byteText(MAX_EDIT_BYTES)}`);
    }
    const out = await ws.writeFile(at.abs, data, expect);
    const sha256 = createHash('sha256').update(data).digest('hex');
    logWrite(env, ws, 'wrote', at, ` (${data.length} bytes)`);
    return { ok: true, mtimeMs: out.mtimeMs, size: out.size, sha256 };
  } catch (e) {
    if (e instanceof WorkspaceConflictError) {
      const conflict: FilesPanelConflict = {
        ok: false,
        conflict: true,
        exists: e.exists,
        ...(e.size !== undefined ? { size: e.size } : {}),
        ...(e.mtimeMs !== undefined ? { mtimeMs: e.mtimeMs } : {}),
        error: e.exists ? 'The file changed since it was opened.' : 'The file is gone.',
      };
      return conflict;
    }
    return fail(e);
  }
}

async function panelCreate(
  env: PanelEnv,
  ref: ConversationRef,
  input: string,
  dir: boolean
): Promise<FilesPanelCreateResult> {
  try {
    const ws = need(env, ref);
    const at = await locate(env, ws, input);
    if (dir) {
      const exists = await ws.stat(at.abs);
      if (exists.exists) throw new FilesRefusal(`${where(at)} already exists`);
      await ws.mkdirp(at.abs);
    } else {
      await ws.writeFile(at.abs, new Uint8Array(0), { missing: true });
    }
    logWrite(env, ws, dir ? 'created directory' : 'created', at);
    return { ok: true, path: at.abs, dir };
  } catch (e) {
    if (e instanceof WorkspaceConflictError) return { ok: false, error: `${input} already exists` };
    return fail(e);
  }
}

async function panelRename(
  env: PanelEnv,
  ref: ConversationRef,
  fromInput: string,
  toInput: string
): Promise<FilesPanelRenameResult> {
  try {
    const ws = need(env, ref);
    const from = await locate(env, ws, fromInput);
    const to = await locate(env, ws, toInput);
    if (from.root !== to.root) throw new FilesRefusal('a file cannot be moved between two different roots');
    await ws.rename(from.abs, to.abs, from.root);
    logWrite(env, ws, 'renamed', from, ` to ${to.abs}`);
    return { ok: true, path: to.abs };
  } catch (e) {
    return fail(e);
  }
}

async function panelRemove(env: PanelEnv, ref: ConversationRef, input: string): Promise<FilesPanelRemoveResult> {
  try {
    const ws = need(env, ref);
    const at = await locate(env, ws, input);
    if (at.abs === at.root) throw new FilesRefusal('a root itself cannot be deleted');
    const r = await ws.remove(at.abs, at.root);
    // A directory that still holds something is the one refusal a person can act on. Both machines
    // report it as a flag — recognised by errno, never by the message — and the sentence is written
    // here once.
    if (r.notEmpty) return { ok: false, error: 'That folder is not empty. Delete its contents first.' };
    // Both machines answer the same for a file that was already gone, and both say which it was:
    // "deleted" when something went, "was already gone" when nothing did.
    logWrite(env, ws, r.removed ? 'deleted' : 'found already gone', at);
    return { ok: true, removed: r.removed };
  } catch (e) {
    return fail(e);
  }
}

async function panelSearch(
  env: PanelEnv,
  ref: ConversationRef,
  query: string
): Promise<FilesPanelSearchResult | { ok: false; error: string }> {
  try {
    const ws = need(env, ref);
    const q = query.trim();
    if (!q) throw new FilesRefusal('a search needs a word to look for');
    if (q.length > 200) throw new FilesRefusal('that search is too long');
    const at = await locate(env, ws, '');
    const { hits, truncated } = await searchIn(env, ws, at.abs, q);
    return { ok: true, hits, truncated };
  } catch (e) {
    return fail(e);
  }
}

// ── search ───────────────────────────────────────────────────────────────────────────────────

/**
 * Filename matches under `root`, by whatever the machine can do cheapest.
 *
 * A git repository answers with `git ls-files -co --exclude-standard`: tracked and untracked files
 * that git does not ignore, which is exactly the set a person means by "the files of this
 * project" — and it is one process instead of a walk. Git prints paths relative to the REPOSITORY
 * root, so that root is asked for too, and hits outside this topic's workspace are dropped.
 *
 * Anything else is walked, bounded on every axis: depth, directories, entries and hits. The walk
 * skips the trees nobody means (`node_modules`, build output, VCS metadata) rather than trying to
 * enumerate them and filter afterwards.
 */
async function searchIn(
  env: PanelEnv,
  ws: Workspace,
  root: string,
  query: string
): Promise<{ hits: FilesPanelHit[]; truncated: boolean }> {
  const top = await ws.run(['git', '-C', root, 'rev-parse', '--show-toplevel']);
  const repo = top.code === 0 && !top.spawnError ? top.output.toString('utf8').trim() : '';
  if (repo) {
    const fromGit = await searchGit(env, ws, root, repo, query);
    if (fromGit) return fromGit;
  }
  return searchWalk(ws, root, query);
}

/** `git ls-files`, or undefined when git itself failed (no git, an unreadable repository). */
async function searchGit(
  env: PanelEnv,
  ws: Workspace,
  root: string,
  repo: string,
  query: string
): Promise<{ hits: FilesPanelHit[]; truncated: boolean } | undefined> {
  const P = sep(ws);
  const { roots } = await rootsOf(env, ws);
  const inside = (abs: string): boolean => roots.some((r) => abs === r || abs.startsWith(r + P.sep));
  // `-z`: a file name may contain a newline, and splitting on those would invent two files.
  const ls = await ws.run(['git', '-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBytes: 8 << 20 });
  if (ls.code !== 0 || ls.spawnError) return undefined;
  const needle = query.toLowerCase();
  const matched = ls.output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((rel) => P.normalize(P.join(repo, rel)))
    .filter((abs) => inside(abs))
    .filter((abs) => abs.toLowerCase().includes(needle));
  const hits: FilesPanelHit[] = [];
  for (const abs of matched.slice(0, SEARCH_MAX)) {
    const at = await locate(env, ws, abs).catch(() => undefined);
    if (!at) continue;
    hits.push({ path: abs, ...(at.rel !== undefined ? { rel: at.rel } : {}), name: P.basename(abs), dir: false });
  }
  return { hits, truncated: matched.length > SEARCH_MAX || ls.truncated };
}

/** A bounded depth-first walk, for a directory that is not a repository. */
async function searchWalk(
  ws: Workspace,
  root: string,
  query: string
): Promise<{ hits: FilesPanelHit[]; truncated: boolean }> {
  const P = sep(ws);
  const needle = query.toLowerCase();
  const hits: FilesPanelHit[] = [];
  let dirs = 0;
  let seen = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    if (++dirs > WALK_MAX_DIRS) return { hits, truncated: true };
    let entries: FilesPanelEntry[];
    try {
      entries = await ws.listDir(dir);
    } catch {
      continue; // unreadable directory: not a reason to fail the whole search
    }
    for (const e of entries) {
      if (++seen > WALK_MAX_ENTRIES) return { hits, truncated: true };
      const abs = P.join(dir, e.name);
      // The walk starts at the workspace root, so every hit is under it; rel is what the page
      // shows in place of an absolute path that would be noise on every row.
      const rel = abs.startsWith(root + P.sep) ? abs.slice(root.length + 1) : undefined;
      if (e.name.toLowerCase().includes(needle)) {
        if (hits.length >= SEARCH_MAX) return { hits, truncated: true };
        hits.push({ path: abs, name: e.name, dir: e.dir, ...(rel !== undefined ? { rel } : {}) });
      }
      if (e.dir && !WALK_SKIP.has(e.name) && !e.name.startsWith('.') && depth < WALK_MAX_DEPTH) {
        stack.push({ dir: abs, depth: depth + 1 });
      }
    }
  }
  return { hits, truncated: false };
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────

/** Which path library a workspace's paths are written in. A remote host is POSIX whatever we are. */
function sep(ws: Workspace): typeof path.posix {
  return (ws.host === 'local' ? path : path.posix) as typeof path.posix;
}

function expandHome(p: string, home: string, P: typeof path.posix): string {
  if (!home) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return P.join(home, p.slice(2));
  return p;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function byteText(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
