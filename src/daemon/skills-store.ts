import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/load.js';

/**
 * The gateway's own skills — the ones every agent is given, written through `talkcode skills`
 * rather than by hand on each machine.
 *
 * ── What is on disk ──────────────────────────────────────────────────────────────────────────────
 *   <configDir>/skills/<name>/SKILL.md        the skill itself
 *   <configDir>/skills/<name>/{references,templates,scripts}/…   what it carries
 *   <configDir>/skills/.usage.json            source, created, last use, uses, agents, status, pin
 *   <configDir>/skills/.archive/<name>/       archived skills, whole and unmodified
 *   <configDir>/skills/.history/<name>/<id>/  the version before each change, plus one line of meta
 *
 * The dot directories are not skills: `listSkills` and the delivery code only ever look at names
 * that pass `SKILL_NAME_RE`.
 *
 * ── Why a version, and why `patch` must carry it ─────────────────────────────────────────────────
 * An agent writes a skill it has only half read, or two turns edit the same one, and the later
 * write silently undoes the earlier. `show` prints a hash of every file; `patch` takes that hash
 * and refuses if the skill has moved since — the cheap way to force read-before-write without
 * keeping a lock. The version is content, not time, so a revert restores the old version exactly.
 *
 * ── Why history is here, not in git ──────────────────────────────────────────────────────────────
 * The gateway runs in a container that has no git and no operator at its terminal. Every content
 * change therefore copies the old files into `.history` first, so `revert` can put them back; the
 * copy is a whole directory, not a diff, because a skill is small and a broken diff is worse than
 * a few kilobytes. A change that has nothing before it (`create`) is listed but not revertible.
 *
 * This module is filesystem work. It never talks to a platform — the daemon decides what to say
 * when a skill is archived, and the delivery code decides where it goes — and the only thing it
 * writes to the log is a usage file it could not read, which would otherwise look like every
 * skill being new.
 */

export const SKILLS_DIR = 'skills';
export const SKILL_FILE = 'SKILL.md';
export const USAGE_FILE = '.usage.json';
export const ARCHIVE_DIR = '.archive';
export const HISTORY_DIR = '.history';

/** `SKILL.md` is read into every agent's context; past this it is a mistake, not a skill. */
export const MAX_SKILL_BYTES = 20 * 1024;

/** A reference or a script is delivered too, but nothing here needs to be megabytes. */
export const MAX_EXTRA_BYTES = 1024 * 1024;

export const EXTRA_DIRS = ['references', 'templates', 'scripts'] as const;
export type ExtraDir = (typeof EXTRA_DIRS)[number];

/** Lowercase words joined by hyphens, as a harness lists a skill by name. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The two skills the package ships; a managed skill may not shadow either. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['talkcode', 'super']);

export const EXPIRY_DAYS = 14;
export const ARCHIVE_DAYS = 30;
const DAY_MS = 86_400_000;

export type SkillStatus = 'active' | 'expired' | 'archived';
export type SkillSignal = 'skill-tool' | 'slash' | 'path';

/** Where a skill came from: the conversation that created it, so an archive notice has somewhere to go. */
export interface SkillSource {
  conversation?: string;
  platform?: string;
  address?: { channel: string; thread?: string };
  agent?: string;
  /**
   * Set when the automatic review wrote it (`daemon/review.ts`) rather than an agent in a
   * conversation. The conversation fields then name the conversation that was REVIEWED, which is
   * where an archive notice still goes — this is the one bit that says nobody typed it there.
   */
  origin?: 'review';
}

export interface SkillUsage {
  source?: SkillSource;
  createdAt: string;
  lastUsedAt?: string;
  restoredAt?: string;
  archivedAt?: string;
  uses: number;
  agents: string[];
  status: SkillStatus;
  pinned: boolean;
  lastSignal?: SkillSignal;
}

interface UsageFile {
  version: 1;
  skills: Record<string, SkillUsage>;
}

/** One skill as the commands and the delivery code see it. */
export interface SkillRecord {
  name: string;
  description: string;
  version: string;
  status: SkillStatus;
  pinned: boolean;
  createdAt: string;
  lastUsedAt?: string;
  restoredAt?: string;
  uses: number;
  agents: string[];
  source?: SkillSource;
}

export interface SkillFileSet {
  name: string;
  version: string;
  files: Map<string, Buffer>;
}

export interface SkillHistoryEntry {
  id: string;
  at: string;
  action: string;
  beforeVersion?: string;
  afterVersion?: string;
  note?: string;
}

export function skillsRoot(dir = configDir()): string {
  return path.join(dir, SKILLS_DIR);
}

export function skillDir(name: string, dir = configDir()): string {
  return path.join(skillsRoot(dir), name);
}

function archiveRoot(dir = configDir()): string {
  return path.join(skillsRoot(dir), ARCHIVE_DIR);
}

function archivedDir(name: string, dir = configDir()): string {
  return path.join(archiveRoot(dir), name);
}

function historyRoot(dir = configDir()): string {
  return path.join(skillsRoot(dir), HISTORY_DIR);
}

function usagePath(dir = configDir()): string {
  return path.join(skillsRoot(dir), USAGE_FILE);
}

/** A name a skill may have: lowercase words with hyphens, and not one of the bundled two. */
export function validateSkillName(name: string): string {
  const trimmed = name.trim();
  if (!SKILL_NAME_RE.test(trimmed)) {
    throw new Error(`skill name must be lowercase words joined by hyphens (a-z, 0-9), got ${JSON.stringify(name)}`);
  }
  if (trimmed.length > 64) throw new Error(`skill name is too long (${trimmed.length} > 64): ${trimmed}`);
  if (RESERVED_NAMES.has(trimmed)) {
    throw new Error(`"${trimmed}" is one of the bundled skills and cannot be replaced; pick another name`);
  }
  return trimmed;
}

/** A path inside a skill that is not `SKILL.md`: one of the three directories, no escapes. */
export function validateFilePath(file: string): string {
  const raw = file.trim().replace(/^\.\//, '');
  if (!raw) throw new Error('a file path is required');
  if (raw.length > 300) throw new Error(`file path is too long (${raw.length} > 300)`);
  if (raw.includes('\\')) throw new Error(`file path must use "/" separators: ${raw}`);
  const parts = raw.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`file path must stay inside the skill: ${raw}`);
  }
  const top = parts[0]!;
  if (!(EXTRA_DIRS as readonly string[]).includes(top)) {
    throw new Error(`files may only go in ${EXTRA_DIRS.join('/, ')}/: ${raw}`);
  }
  if (parts.length < 2) throw new Error(`a file needs a name inside ${top}/: ${raw}`);
  return parts.join('/');
}

/** The frontmatter a harness reads to list a skill. Only `name` and `description` matter here. */
export function frontmatterFields(text: string): Map<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return new Map();
  const lines = match[1]!.split(/\r?\n/);
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const raw = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(raw)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      out.set(key, parts.join(' ').trim());
      continue;
    }
    out.set(key, unquote(raw));
  }
  return out;
}

function unquote(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw));
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function composeSkillMd(name: string, description: string, body: string): string {
  const text = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
  return body.trim() ? text : text.replace(/\n\n$/, '\n');
}

/** Refuse a `SKILL.md` a harness would not list, or one over the context budget. */
function assertSkillMd(content: string, name: string): void {
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md is ${bytes} bytes, over the ${MAX_SKILL_BYTES}-byte limit`);
  }
  const fields = frontmatterFields(content);
  if (fields.size === 0) throw new Error('SKILL.md must start with a --- frontmatter block naming the skill and describing it');
  if (fields.get('name') !== name) {
    throw new Error(`SKILL.md frontmatter says name: ${fields.get('name') ?? '(missing)'}, but this skill is "${name}"`);
  }
  if (!fields.get('description')?.trim()) throw new Error('SKILL.md frontmatter needs a non-empty description');
}

function iso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function emptyUsage(): UsageFile {
  return { version: 1, skills: {} };
}

function readUsage(dir = configDir()): UsageFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(usagePath(dir), 'utf8')) as Partial<UsageFile>;
    if (parsed.version !== 1 || !parsed.skills || typeof parsed.skills !== 'object') {
      console.warn(`[skills] ${usagePath(dir)} is not a version-1 usage file; starting its records over`);
      return emptyUsage();
    }
    return { version: 1, skills: parsed.skills };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[skills] could not read ${usagePath(dir)}: ${e instanceof Error ? e.message : e}`);
    }
    return emptyUsage();
  }
}

function writeAtomic(file: string, data: string | Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

function writeUsage(usage: UsageFile, dir = configDir()): void {
  writeAtomic(usagePath(dir), `${JSON.stringify(usage, null, 2)}\n`, 0o600);
}

/** Every file a skill is made of: SKILL.md and the three directories. Nothing else is delivered. */
function readDeliveredFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const md = path.join(root, SKILL_FILE);
  if (fs.existsSync(md)) files.set(SKILL_FILE, fs.readFileSync(md));
  for (const sub of EXTRA_DIRS) {
    const base = path.join(root, sub);
    for (const rel of listFiles(base)) files.set(`${sub}/${rel}`, fs.readFileSync(path.join(base, rel)));
  }
  return files;
}

export function readSkillFiles(name: string, dir = configDir()): Map<string, Buffer> {
  return readDeliveredFiles(skillDir(name, dir));
}

/**
 * The files of an ACTIVE or ARCHIVED skill, by path and size, sorted.
 *
 * The web UI's file list is the only caller: `readSkillFiles` reads the live directory and
 * `show` returns one file's text, so neither can answer "what else does this skill carry" for
 * something in `.archive/`. Read-only, and it validates the name before touching a path.
 *
 * An archived skill is read through the same delivered-files filter as a live one, not the whole
 * directory: an agent can leave a root-level file there with a shell command, and listing it
 * would offer the page a button whose every click `show` refuses (`validateFilePath` accepts only
 * SKILL.md and the three directories).
 */
export function listSkillFiles(name: string, dir = configDir()): Array<{ path: string; size: number }> {
  const clean = validateSkillName(name);
  const active = fs.existsSync(skillDir(clean, dir));
  const archived = archivedDir(clean, dir);
  if (!active && !fs.existsSync(archived)) {
    throw new Error(`no skill named "${clean}"; \`talkcode skills list\` shows them`);
  }
  const files = active ? readSkillFiles(clean, dir) : readDeliveredFiles(archived);
  return [...files]
    .map(([rel, data]) => ({ path: rel, size: data.length }))
    .sort((a, b) => (a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : a.path.localeCompare(b.path)));
}

function listFiles(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function readAllFiles(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const rel of listFiles(dir)) files.set(rel, fs.readFileSync(path.join(dir, rel)));
  return files;
}

/** A content hash over every delivered file — the version `show` prints and `patch` demands. */
export function skillVersionOf(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const rel of [...files.keys()].sort()) {
    const data = files.get(rel)!;
    hash.update(`${rel}\0${data.length}\0`);
    hash.update(data);
  }
  return hash.digest('hex').slice(0, 12);
}

export function skillVersion(name: string, dir = configDir()): string {
  return skillVersionOf(readSkillFiles(name, dir));
}

function descriptionOf(files: Map<string, Buffer>): string {
  const md = files.get(SKILL_FILE);
  if (!md) return '';
  return frontmatterFields(md.toString('utf8')).get('description')?.trim() ?? '';
}

function defaultUsage(name: string, dir: string): SkillUsage {
  let createdAt = iso();
  try {
    createdAt = iso(fs.statSync(skillDir(name, dir)).mtimeMs);
  } catch {
    // a record for something already gone; the timestamp only has to exist
  }
  return { createdAt, uses: 0, agents: [], status: 'active', pinned: false };
}

function lastActivity(usage: SkillUsage): number {
  const at = (s: string | undefined): number => (s ? Date.parse(s) || 0 : 0);
  return Math.max(at(usage.lastUsedAt), at(usage.restoredAt), at(usage.createdAt));
}

/** What the status is now, even between sweeps: a pin wins, then 14 days of no use. */
export function derivedStatus(usage: SkillUsage, archived: boolean, now = Date.now()): SkillStatus {
  if (archived) return 'archived';
  if (usage.pinned) return 'active';
  return now - lastActivity(usage) >= EXPIRY_DAYS * DAY_MS ? 'expired' : 'active';
}

function recordOf(name: string, usage: SkillUsage, files: Map<string, Buffer>, archived: boolean, now: number): SkillRecord {
  return {
    name,
    description: descriptionOf(files),
    version: skillVersionOf(files),
    status: derivedStatus(usage, archived, now),
    pinned: usage.pinned,
    createdAt: usage.createdAt,
    lastUsedAt: usage.lastUsedAt,
    restoredAt: usage.restoredAt,
    uses: usage.uses,
    agents: [...usage.agents],
    source: usage.source,
  };
}

/** The skills that exist right now, active ones first, then archived; sorted by name. */
export function listSkills(dir = configDir(), now = Date.now()): SkillRecord[] {
  const usage = readUsage(dir);
  const names = new Set<string>(activeSkillNames(dir));
  const archived = new Set<string>(archivedSkillNames(dir));
  for (const name of archived) names.add(name);
  return [...names]
    .sort()
    .map((name) => {
      const isArchived = archived.has(name);
      const files = isArchived ? readAllFiles(archivedDir(name, dir)) : readSkillFiles(name, dir);
      return recordOf(name, usage.skills[name] ?? defaultUsage(name, dir), files, isArchived, now);
    });
}

/** Skill directory names, active only. Dot entries (`.usage.json`, `.archive`, `.history`) are not skills. */
export function activeSkillNames(dir = configDir()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot(dir), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && SKILL_NAME_RE.test(e.name))
    .map((e) => e.name);
}

export function archivedSkillNames(dir = configDir()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot(dir), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isDirectory() && SKILL_NAME_RE.test(e.name))
    .map((e) => e.name);
}

/** Every active skill with its files, for delivery. Read once per spawn. */
export function activeSkillFiles(dir = configDir()): SkillFileSet[] {
  return activeSkillNames(dir)
    .map((name) => {
      const files = readSkillFiles(name, dir);
      return { name, version: skillVersionOf(files), files };
    })
    .filter((s) => s.files.has(SKILL_FILE));
}

function requireActive(name: string, dir: string): string {
  const root = skillDir(name, dir);
  if (!fs.existsSync(root)) {
    if (fs.existsSync(archivedDir(name, dir))) throw new Error(`"${name}" is archived; restore it first with \`talkcode skills restore ${name}\``);
    throw new Error(`no skill named "${name}"; \`talkcode skills list\` shows them`);
  }
  return root;
}

function historyId(now: number): string {
  return `${String(now).padStart(15, '0')}-${randomBytes(3).toString('hex')}`;
}

function saveHistory(
  name: string,
  dir: string,
  action: string,
  beforeVersion: string | undefined,
  afterVersion: string | undefined,
  note: string | undefined,
  files: Map<string, Buffer> | undefined,
  now: number
): SkillHistoryEntry {
  const id = historyId(now);
  const base = path.join(historyRoot(dir), name, id);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (files) {
    for (const [rel, data] of files) {
      const dest = path.join(base, 'files', ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, data, { mode: 0o600 });
    }
  }
  const entry: SkillHistoryEntry = {
    id,
    at: iso(now),
    action,
    ...(beforeVersion ? { beforeVersion } : {}),
    ...(afterVersion ? { afterVersion } : {}),
    ...(note ? { note } : {}),
  };
  writeAtomic(path.join(base, 'meta.json'), `${JSON.stringify(entry, null, 2)}\n`, 0o600);
  return entry;
}

/** Every recorded change, newest first. `create` entries have nothing to revert to. */
export function skillHistory(name: string, dir = configDir()): SkillHistoryEntry[] {
  const root = path.join(historyRoot(dir), name);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, e.name, 'meta.json'), 'utf8')) as SkillHistoryEntry;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is SkillHistoryEntry => e !== undefined)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export interface CreateSkillInput {
  name: string;
  description: string;
  body?: string;
  source?: SkillSource;
  /** A line for the history entry — the phase-3 review's reason, when there is one. */
  note?: string;
  now?: number;
}

/** Create a skill from a one-line description and an optional body. */
export function createSkill(input: CreateSkillInput, dir = configDir()): SkillRecord {
  const name = validateSkillName(input.name);
  const root = skillDir(name, dir);
  if (fs.existsSync(root)) throw new Error(`a skill named "${name}" already exists; use \`talkcode skills show ${name}\` and patch it`);
  if (fs.existsSync(archivedDir(name, dir))) {
    throw new Error(`"${name}" is archived; restore it with \`talkcode skills restore ${name}\`, or pick another name`);
  }
  const description = input.description.replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('create needs --description: one line on when to use the skill');
  if (description.length > 2000) throw new Error(`description is too long (${description.length} > 2000)`);
  const content = composeSkillMd(name, description, input.body ?? '');
  assertSkillMd(content, name);
  const now = input.now ?? Date.now();
  fs.mkdirSync(skillsRoot(dir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(root, SKILL_FILE), content, 0o600);
  const usage = readUsage(dir);
  usage.skills[name] = {
    ...(input.source ? { source: input.source } : {}),
    createdAt: iso(now),
    uses: 0,
    agents: [],
    status: 'active',
    pinned: false,
  };
  writeUsage(usage, dir);
  saveHistory(name, dir, 'create', undefined, skillVersion(name, dir), input.note, undefined, now);
  return recordOf(name, usage.skills[name]!, readSkillFiles(name, dir), false, now);
}

export interface PatchSkillInput {
  name: string;
  version: string;
  content: string;
  /** A line for the history entry — the phase-3 review's reason, when there is one. */
  note?: string;
  now?: number;
}

/** Replace SKILL.md, but only from the version the caller read with `show`. */
export function patchSkill(input: PatchSkillInput, dir = configDir()): SkillRecord {
  const name = validateSkillName(input.name);
  requireActive(name, dir);
  const files = readSkillFiles(name, dir);
  const current = skillVersionOf(files);
  if (input.version !== current) {
    throw new Error(
      `version mismatch: "${name}" is at ${current}, not ${input.version}. Run \`talkcode skills show ${name}\` and pass the version it prints.`
    );
  }
  assertSkillMd(input.content, name);
  const next = new Map(files);
  next.set(SKILL_FILE, Buffer.from(input.content));
  const after = skillVersionOf(next);
  const now = input.now ?? Date.now();
  saveHistory(name, dir, 'patch', current, after, input.note, files, now);
  writeAtomic(path.join(skillDir(name, dir), SKILL_FILE), input.content, 0o600);
  const usage = readUsage(dir);
  const rec = usage.skills[name] ?? defaultUsage(name, dir);
  // Editing is not use: a skill already expired stays expired, and a patch does not reset its clock.
  usage.skills[name] = rec;
  writeUsage(usage, dir);
  return recordOf(name, usage.skills[name]!, next, false, now);
}

export interface WriteFileInput {
  name: string;
  file: string;
  content: string;
  /** A line for the history entry — the phase-3 review's reason, when there is one. */
  note?: string;
  now?: number;
}

/** Write one reference, template or script. */
export function writeSkillFile(input: WriteFileInput, dir = configDir()): SkillRecord {
  const name = validateSkillName(input.name);
  const rel = validateFilePath(input.file);
  requireActive(name, dir);
  const bytes = Buffer.byteLength(input.content);
  if (bytes > MAX_EXTRA_BYTES) throw new Error(`${rel} is ${bytes} bytes, over the ${MAX_EXTRA_BYTES}-byte limit`);
  const files = readSkillFiles(name, dir);
  const before = skillVersionOf(files);
  const next = new Map(files);
  next.set(rel, Buffer.from(input.content));
  const after = skillVersionOf(next);
  const now = input.now ?? Date.now();
  saveHistory(name, dir, 'write-file', before, after, input.note ? `${rel} — ${input.note}` : rel, files, now);
  writeAtomic(path.join(skillDir(name, dir), ...rel.split('/')), input.content, rel.startsWith('scripts/') ? 0o700 : 0o600);
  return recordOf(name, readUsage(dir).skills[name] ?? defaultUsage(name, dir), next, false, now);
}

/** Remove one extra file. `SKILL.md` is not removable; archive the skill instead. */
export function removeSkillFile(input: { name: string; file: string; note?: string; now?: number }, dir = configDir()): SkillRecord {
  const name = validateSkillName(input.name);
  const rel = validateFilePath(input.file);
  requireActive(name, dir);
  const files = readSkillFiles(name, dir);
  if (!files.has(rel)) throw new Error(`"${name}" has no file ${rel}`);
  const before = skillVersionOf(files);
  const next = new Map(files);
  next.delete(rel);
  const after = skillVersionOf(next);
  const now = input.now ?? Date.now();
  saveHistory(name, dir, 'remove-file', before, after, input.note ? `${rel} — ${input.note}` : rel, files, now);
  fs.rmSync(path.join(skillDir(name, dir), ...rel.split('/')), { force: true });
  pruneEmptyDirs(path.dirname(path.join(skillDir(name, dir), ...rel.split('/'))), skillDir(name, dir));
  return recordOf(name, readUsage(dir).skills[name] ?? defaultUsage(name, dir), next, false, now);
}

function pruneEmptyDirs(from: string, stop: string): void {
  let dir = from;
  while (dir.startsWith(stop + path.sep) && dir !== stop) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Move a skill into `.archive` — never delete it. */
export function archiveSkill(name: string, dir = configDir(), now = Date.now()): SkillRecord {
  const clean = validateSkillName(name);
  const active = skillDir(clean, dir);
  const archived = archivedDir(clean, dir);
  if (!fs.existsSync(active)) {
    if (fs.existsSync(archived)) {
      return recordOf(clean, readUsage(dir).skills[clean] ?? defaultUsage(clean, dir), readAllFiles(archived), true, now);
    }
    throw new Error(`no skill named "${clean}"`);
  }
  fs.mkdirSync(archiveRoot(dir), { recursive: true, mode: 0o700 });
  fs.renameSync(active, archived);
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  usage.skills[clean] = { ...rec, status: 'archived', archivedAt: iso(now) };
  writeUsage(usage, dir);
  return recordOf(clean, usage.skills[clean]!, readAllFiles(archived), true, now);
}

/** Bring an archived skill back, with its clock reset so the next sweep leaves it alone. */
export function restoreSkill(name: string, dir = configDir(), now = Date.now()): SkillRecord {
  const clean = validateSkillName(name);
  const active = skillDir(clean, dir);
  const archived = archivedDir(clean, dir);
  if (fs.existsSync(active)) throw new Error(`"${clean}" is already active`);
  if (!fs.existsSync(archived)) throw new Error(`no archived skill named "${clean}"`);
  fs.mkdirSync(skillsRoot(dir), { recursive: true, mode: 0o700 });
  fs.renameSync(archived, active);
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  const { archivedAt: _archivedAt, ...rest } = rec;
  usage.skills[clean] = { ...rest, status: 'active', restoredAt: iso(now) };
  writeUsage(usage, dir);
  return recordOf(clean, usage.skills[clean]!, readSkillFiles(clean, dir), false, now);
}

export function pinSkill(name: string, pinned: boolean, dir = configDir()): SkillRecord {
  const clean = validateSkillName(name);
  const usage = readUsage(dir);
  const rec = usage.skills[clean];
  if (!rec) throw new Error(`no skill named "${clean}"`);
  if (!fs.existsSync(skillDir(clean, dir)) && !fs.existsSync(archivedDir(clean, dir))) {
    throw new Error(`no skill named "${clean}"`);
  }
  usage.skills[clean] = { ...rec, pinned };
  writeUsage(usage, dir);
  const archived = !fs.existsSync(skillDir(clean, dir));
  const files = archived ? readAllFiles(archivedDir(clean, dir)) : readSkillFiles(clean, dir);
  return recordOf(clean, usage.skills[clean]!, files, archived, Date.now());
}

/** Mark a skill expired without moving it. Returns whether the stored status changed. */
export function markExpired(name: string, dir = configDir()): boolean {
  const usage = readUsage(dir);
  const rec = usage.skills[name];
  if (!rec || rec.pinned || rec.status === 'expired') return false;
  usage.skills[name] = { ...rec, status: 'expired' };
  writeUsage(usage, dir);
  return true;
}

/** Count one use: last time, total, which agent, and back to active if it had gone stale. */
export function recordSkillUse(name: string, agent: string | undefined, signal: SkillSignal, dir = configDir(), now = Date.now()): void {
  if (!fs.existsSync(skillDir(name, dir))) return;
  const usage = readUsage(dir);
  const rec = usage.skills[name] ?? defaultUsage(name, dir);
  usage.skills[name] = {
    ...rec,
    lastUsedAt: iso(now),
    uses: rec.uses + 1,
    agents: agent && !rec.agents.includes(agent) ? [...rec.agents, agent] : rec.agents,
    status: 'active',
    lastSignal: signal,
  };
  writeUsage(usage, dir);
}

export interface RevertResult {
  skill: SkillRecord;
  entry: SkillHistoryEntry;
}

/** Put the files from one history entry back, recording the change as a new entry. */
export function revertSkill(name: string, id: string, dir = configDir(), now = Date.now()): RevertResult {
  const clean = validateSkillName(name);
  const entry = skillHistory(clean, dir).find((e) => e.id === id);
  if (!entry) throw new Error(`"${clean}" has no history entry ${id}; \`talkcode skills history ${clean}\` lists them`);
  const snapshot = path.join(historyRoot(dir), clean, id, 'files');
  if (!fs.existsSync(snapshot)) throw new Error(`history entry ${id} is the skill's first version; there is nothing before it to restore`);
  const target = readAllFiles(snapshot);
  if (!target.has(SKILL_FILE)) throw new Error(`history entry ${id} has no SKILL.md; refusing to restore a broken snapshot`);
  const active = skillDir(clean, dir);
  const archived = archivedDir(clean, dir);
  const currentDir = fs.existsSync(active) ? active : fs.existsSync(archived) ? archived : undefined;
  if (!currentDir) throw new Error(`no skill named "${clean}"`);
  const current = readAllFiles(currentDir);
  const before = skillVersionOf(current);
  const after = skillVersionOf(target);
  const logged = saveHistory(clean, dir, 'revert', before, after, `revert ${id}`, current, now);
  const tmp = path.join(skillsRoot(dir), `.revert-${clean}-${process.pid}-${randomBytes(3).toString('hex')}`);
  for (const [rel, data] of target) {
    const dest = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, data, { mode: rel.startsWith('scripts/') ? 0o700 : 0o600 });
  }
  fs.rmSync(currentDir, { recursive: true, force: true });
  fs.renameSync(tmp, active);
  if (fs.existsSync(archived)) fs.rmSync(archived, { recursive: true, force: true });
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  usage.skills[clean] = { ...rec, status: 'active', restoredAt: iso(now) };
  writeUsage(usage, dir);
  return { skill: recordOf(clean, usage.skills[clean]!, readSkillFiles(clean, dir), false, now), entry: logged };
}

/** What `show` prints: one file, and the version every later `patch` has to name. */
export function showSkill(name: string, file: string | undefined, dir = configDir()): { name: string; file: string; version: string; status: SkillStatus; content: string } {
  const clean = validateSkillName(name);
  const active = fs.existsSync(skillDir(clean, dir));
  const root = active ? skillDir(clean, dir) : archivedDir(clean, dir);
  if (!active && !fs.existsSync(root)) throw new Error(`no skill named "${clean}"; \`talkcode skills list\` shows them`);
  const rel = file === undefined || file === SKILL_FILE ? SKILL_FILE : validateFilePath(file);
  const target = path.join(root, ...rel.split('/'));
  let content: string;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`"${clean}" has no ${rel}`);
    throw e;
  }
  const usage = readUsage(dir).skills[clean] ?? defaultUsage(clean, dir);
  const files = active ? readSkillFiles(clean, dir) : readAllFiles(root);
  return {
    name: clean,
    file: rel,
    version: skillVersionOf(files),
    status: derivedStatus(usage, !active),
    content,
  };
}
