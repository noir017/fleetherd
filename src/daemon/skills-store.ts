import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config/load.js';
import {
  commitPaths,
  filesAt,
  initRepo,
  isRepo,
  logPaths,
  parentOf,
  resolveCommit,
  type SkillChangeBy,
} from './skills-git.js';

/**
 * The gateway's own skills — the ones every agent is given, written through `talkcode skills`
 * rather than by hand on each machine.
 *
 * ── What is on disk ──────────────────────────────────────────────────────────────────────────────
 *   <configDir>/skills/                         a git repository (skills-repo.ts keeps it in step
 *                                               with `skills.repo` when one is configured)
 *   <configDir>/skills/skills/<name>/SKILL.md   the skill itself
 *   <configDir>/skills/skills/<name>/{references,templates,scripts}/…   what it carries
 *   <configDir>/skills/archive/<name>/          archived skills, whole and unmodified
 *   <configDir>/skills-usage.json               source, created, last use, uses, agents, status, pin
 *
 * The layout is agent-skills' own (`skills/<name>/SKILL.md`), because that repository is the one
 * the gateway shares with the people who edit skills by hand; anything else in it (its README,
 * its scripts, `skills-alone/`) is not read here. The usage file stays outside the repository: it
 * changes on every use, and a commit per use would bury every real change in the log.
 *
 * ── Why a version, and why `patch` must carry it ─────────────────────────────────────────────────
 * An agent writes a skill it has only half read, or two turns edit the same one, and the later
 * write silently undoes the earlier. `show` prints a hash of every file; `patch` takes that hash
 * and refuses if the skill has moved since — the cheap way to force read-before-write without
 * keeping a lock. The version is content, not time, so a revert restores the old version exactly,
 * and a person's commit pulled from the repository moves it the same way an agent's write does.
 *
 * ── History is git ───────────────────────────────────────────────────────────────────────────────
 * Every content change is one commit (skills-git.ts commitPaths), carrying the action and the
 * versions in trailers. `history` is `git log` over the skill's two places, so a person's commit is
 * listed beside the gateway's, and `revert <id>` puts back the files as they were just before that
 * commit — whoever made it.
 *
 * This module is filesystem and local-git work. It never talks to a platform or a remote — the
 * daemon decides what to say when a skill is archived, skills-repo.ts decides when to fetch and
 * push, and the delivery code decides where a skill goes.
 */

/** The repository under the config directory. */
export const REPO_DIR = 'skills';
/** Active skills, inside the repository. */
export const SKILLS_DIR = 'skills';
export const ARCHIVE_DIR = 'archive';
export const SKILL_FILE = 'SKILL.md';
export const USAGE_FILE = 'skills-usage.json';

/**
 * `SKILL.md` is read into an agent's context when the skill is used. 64 KB rather than the 20 KB
 * this started with: agent-skills' own `hindsight-ops` is 44 KB and `server-ops` 26 KB, both
 * written by hand and in daily use (raised 2026-11-06).
 */
export const MAX_SKILL_BYTES = 64 * 1024;

/** A reference or a script is delivered too, but nothing here needs to be megabytes. */
export const MAX_EXTRA_BYTES = 1024 * 1024;

export const EXTRA_DIRS = ['references', 'templates', 'scripts'] as const;

/**
 * The gateway's keys under a skill's frontmatter `metadata:`. The Agent Skills spec makes
 * `metadata` a map of strings to strings, so each is a flat, quoted string — a harness that
 * validates the spec lists the skill unchanged, and one that does not ignores the block.
 */
export const META_RESIDENT = 'talkcode-resident';
export const META_CATEGORY = 'talkcode-category';
export const META_HOSTS = 'talkcode-hosts';
export const META_HARNESSES = 'talkcode-harnesses';

/**
 * A resident skill's description is in every agent's context on every request, so it is held to
 * one short line (decided 2026-11-06, after Hermes, which holds its whole index to 60 characters).
 * A library skill's is not: it is read only by the search, where more words find it more often.
 */
export const RESIDENT_DESCRIPTION_MAX = 120;
export type ExtraDir = (typeof EXTRA_DIRS)[number];

/**
 * Where a skill sits and who gets it, read from its frontmatter.
 *
 * - resident: linked into every harness's skill directory, so its name and description are in
 *   every agent's context. Only a person makes a skill resident (the web UI's page, or a commit);
 *   see `assertResidentUnchanged`.
 * - library (resident false): delivered to every host but not linked — reached through the
 *   `skills` tool's search, so a library of hundreds costs one tool definition, not hundreds of
 *   descriptions.
 * - hosts / harnesses: when set, only agents on those hosts, or of those harnesses, get it at all.
 */
export interface SkillMeta {
  resident: boolean;
  category?: string;
  hosts?: string[];
  harnesses?: string[];
}

/** Lowercase words joined by hyphens, as a harness lists a skill by name. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a directory name is one a skill could have — what the delivery code and the migration list. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && name.length <= 64;
}

/** The two skills the package ships; a managed skill may not shadow either. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['talkcode', 'super']);

export const EXPIRY_DAYS = 14;
export const ARCHIVE_DAYS = 30;
const DAY_MS = 86_400_000;

export type SkillStatus = 'active' | 'expired' | 'archived';
/** How a use was seen: the harness's Skill tool, `/<name>`, a file of it touched, or read through `show`. */
export type SkillSignal = 'skill-tool' | 'slash' | 'path' | 'read';
export type { SkillChangeBy } from './skills-git.js';

/** A change with no `by` was made by an agent through `talkcode skills`. */
const AGENT: SkillChangeBy = { kind: 'agent' };

/**
 * Where a skill came from: the conversation that created it, so an archive notice has somewhere to
 * go. A skill with no source was not created through the gateway — a person committed it to the
 * repository, or created it on the web UI's page — and the expiry check leaves it alone: nothing
 * the gateway sees tells it whether a hand-written skill is still read from a terminal.
 */
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
  /** Why this skill is not delivered — a hand-made change the store's rules would have refused. */
  problem?: string;
  /** Delivered, but breaking a rule a person should know about (a resident description too long). */
  warning?: string;
  resident: boolean;
  category?: string;
  hosts?: string[];
  harnesses?: string[];
}

export interface SkillFileSet {
  name: string;
  version: string;
  files: Map<string, Buffer>;
  meta: SkillMeta;
}

export interface SkillHistoryEntry {
  /** The commit, 12 hex characters; what `revert` takes. */
  id: string;
  at: string;
  /** The gateway's action, or `commit` for a change someone made in the repository by hand. */
  action: string;
  /** The commit's author: `talkcode`, `talkcode-review`, `talkcode-web`, or a person. */
  author?: string;
  beforeVersion?: string;
  afterVersion?: string;
  note?: string;
}

/** The repository the skills live in. */
export function repoRoot(dir = configDir()): string {
  return path.join(dir, REPO_DIR);
}

export function skillsRoot(dir = configDir()): string {
  return path.join(repoRoot(dir), SKILLS_DIR);
}

export function skillDir(name: string, dir = configDir()): string {
  return path.join(skillsRoot(dir), name);
}

function archiveRoot(dir = configDir()): string {
  return path.join(repoRoot(dir), ARCHIVE_DIR);
}

function archivedDir(name: string, dir = configDir()): string {
  return path.join(archiveRoot(dir), name);
}

export function usagePath(dir = configDir()): string {
  return path.join(dir, USAGE_FILE);
}

/** The repository paths a skill can be at: what a commit about it stages, and what `history` reads. */
function skillPaths(name: string): string[] {
  return [`${SKILLS_DIR}/${name}`, `${ARCHIVE_DIR}/${name}`];
}

/**
 * Make sure there is a repository to commit to. A store nobody has written to yet gets an empty
 * one; anything else that is not a repository is an old store skills-repo.ts has not moved yet,
 * and writing into it would turn the operator's skills directory into a repository of the wrong
 * shape.
 */
function ensureRepo(dir: string): string {
  const root = repoRoot(dir);
  if (isRepo(root)) return root;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (entries.length > 0) {
    throw new Error(`${root} is not a git repository yet; the gateway moves the old skills store into one when it starts`);
  }
  initRepo(root);
  return root;
}

function commit(dir: string, name: string, info: { action: string; note?: string; before?: string; after?: string; by?: SkillChangeBy; now: number }): void {
  commitPaths(repoRoot(dir), skillPaths(name), {
    action: info.action,
    skill: name,
    ...(info.note ? { note: info.note } : {}),
    ...(info.before ? { beforeVersion: info.before } : {}),
    ...(info.after ? { afterVersion: info.after } : {}),
    by: info.by ?? AGENT,
    at: info.now,
  });
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

/**
 * The first-level keys under a top-level `metadata:` block of the frontmatter. Deeper levels (a
 * `hermes:` map some skills carry for another agent) are skipped, not misread as the gateway's.
 */
export function frontmatterMetadata(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return out;
  const lines = match[1]!.split(/\r?\n/);
  const start = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (start < 0) return out;
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const lead = /^(\s*)/.exec(line)![1]!.length;
    if (lead === 0) break;
    indent ??= lead;
    if (lead !== indent) continue;
    const kv = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]!.trim()) out.set(kv[1]!, unquote(kv[2]!.trim()));
  }
  return out;
}

function listOf(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

/** A skill's tier, category and conditions, from its SKILL.md. */
export function skillMetaOf(files: Map<string, Buffer>): SkillMeta {
  const md = files.get(SKILL_FILE);
  const meta = md ? frontmatterMetadata(md.toString('utf8')) : new Map<string, string>();
  const category = meta.get(META_CATEGORY)?.trim();
  const hosts = listOf(meta.get(META_HOSTS));
  const harnesses = listOf(meta.get(META_HARNESSES));
  return {
    resident: meta.get(META_RESIDENT)?.trim().toLowerCase() === 'true',
    ...(category ? { category } : {}),
    ...(hosts ? { hosts } : {}),
    ...(harnesses ? { harnesses } : {}),
  };
}

/**
 * Whether an agent gets a skill at all: no condition, or its host and harness among the named
 * ones. `host` is the agent's `host:` (`local` for one on the gateway's own machine); `harness` is
 * its kind as the delivery names it (`claude`, `codex`, `opencode`, `agy`, `codebuddy`, …).
 */
export function skillReaches(meta: SkillMeta, host: string, harness: string): boolean {
  if (meta.hosts && !meta.hosts.includes(host)) return false;
  if (meta.harnesses && !meta.harnesses.includes(harness)) return false;
  return true;
}

/** The warning a person should see on a delivered skill, or undefined. */
function skillWarning(meta: SkillMeta, files: Map<string, Buffer>): string | undefined {
  if (!meta.resident) return undefined;
  const length = [...descriptionOf(files)].length;
  return length > RESIDENT_DESCRIPTION_MAX
    ? `the description is ${length} characters; a resident skill's is in every agent's context and should be at most ${RESIDENT_DESCRIPTION_MAX}`
    : undefined;
}

/**
 * Refuse a write that would move a skill in or out of every agent's context unless a person makes
 * it. An agent or the review writes library skills; promoting one to resident — or demoting one a
 * person chose — is the person's call, made on the web UI's page or in the repository.
 */
function assertResidentUnchanged(before: SkillMeta, after: SkillMeta, by: SkillChangeBy | undefined): void {
  if (before.resident === after.resident || by?.kind === 'person') return;
  throw new Error(
    `${META_RESIDENT} decides whether a skill is in every agent's context, and only a person changes it (the web UI's skills page, or a commit to the repository); patch the skill without changing that line`
  );
}

/** A resident skill's description must fit one short line; checked on every write the gateway makes. */
function assertResidentDescription(meta: SkillMeta, content: string): void {
  if (!meta.resident) return;
  const description = frontmatterFields(content).get('description')?.trim() ?? '';
  const length = [...description].length;
  if (length > RESIDENT_DESCRIPTION_MAX) {
    throw new Error(
      `a resident skill's description is in every agent's context: at most ${RESIDENT_DESCRIPTION_MAX} characters, this one is ${length}; shorten it and move the detail into the body`
    );
  }
}

/**
 * SKILL.md with `talkcode-resident` set or removed. Removed rather than set to "false": absence is
 * the library tier, so a skill that was never promoted and one that was demoted read the same.
 */
export function withResident(content: string, resident: boolean): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
  if (!match) throw new Error('SKILL.md has no frontmatter to set the tier in');
  const lines = match[2]!.split(/\r?\n/);
  const start = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  const isResidentLine = (l: string): boolean => new RegExp(`^\\s+${META_RESIDENT}:`).test(l);
  let next: string[];
  if (start < 0) {
    next = resident ? [...lines, 'metadata:', `  ${META_RESIDENT}: "true"`] : lines;
  } else {
    let end = start + 1;
    while (end < lines.length && (!lines[end]!.trim() || /^\s/.test(lines[end]!))) end++;
    const block = lines.slice(start + 1, end).filter((l) => !isResidentLine(l));
    const indent = /^(\s+)/.exec(block.find((l) => l.trim()) ?? '  ')?.[1] ?? '  ';
    const kept = resident ? [`${indent}${META_RESIDENT}: "true"`, ...block] : block;
    next = [...lines.slice(0, start), ...(kept.some((l) => l.trim()) ? ['metadata:', ...kept] : []), ...lines.slice(end)];
  }
  return `${match[1]}${next.join('\n')}${match[3]}${content.slice(match[0].length)}`;
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

/**
 * Whether the expiry check applies: only to a skill the gateway created (it has a source) and
 * nobody pinned. A hand-written skill is read from terminals the gateway never sees, so "unused
 * for 30 days" would be a guess about it, not a fact.
 */
export function canExpire(usage: SkillUsage): boolean {
  return usage.source !== undefined && !usage.pinned;
}

/** What the status is now, even between sweeps: a pin (or no source) wins, then 14 days of no use. */
export function derivedStatus(usage: SkillUsage, archived: boolean, now = Date.now()): SkillStatus {
  if (archived) return 'archived';
  if (!canExpire(usage)) return 'active';
  return now - lastActivity(usage) >= EXPIRY_DAYS * DAY_MS ? 'expired' : 'active';
}

/**
 * Why a skill in the repository would not be delivered, or undefined when it would. The store's
 * own writes cannot produce any of these; a person's commit can, and a skill a harness would not
 * list, or one over the size cap, must not reach every agent just because it arrived by `git pull`.
 */
export function skillProblem(name: string, files: Map<string, Buffer>): string | undefined {
  if (RESERVED_NAMES.has(name)) return `"${name}" is one of the bundled skills`;
  const md = files.get(SKILL_FILE);
  if (!md) return 'no SKILL.md';
  try {
    assertSkillMd(md.toString('utf8'), name);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  for (const [rel, data] of files) {
    if (rel !== SKILL_FILE && data.length > MAX_EXTRA_BYTES) return `${rel} is ${data.length} bytes, over the ${MAX_EXTRA_BYTES}-byte limit`;
  }
  return undefined;
}

function recordOf(name: string, usage: SkillUsage, files: Map<string, Buffer>, archived: boolean, now: number): SkillRecord {
  const problem = archived ? undefined : skillProblem(name, files);
  const meta = skillMetaOf(files);
  const warning = archived || problem ? undefined : skillWarning(meta, files);
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
    ...(problem ? { problem } : {}),
    ...(warning ? { warning } : {}),
    ...meta,
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

/** Skill directory names, active only. Anything that is not a valid name (a dot entry) is not a skill. */
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

/** The skills already logged as not delivered, by name and version, so a spawn does not repeat it. */
const reportedProblems = new Set<string>();

/**
 * Every active skill with its files, for delivery. Read once per spawn. A skill that breaks the
 * store's rules (`skillProblem`) is left out and logged once per version: degrading to "this one
 * skill is missing" is the explicit failure, a broken one in every agent's skill menu is not.
 */
export function activeSkillFiles(dir = configDir()): SkillFileSet[] {
  const out: SkillFileSet[] = [];
  for (const name of activeSkillNames(dir)) {
    const files = readSkillFiles(name, dir);
    const version = skillVersionOf(files);
    const problem = skillProblem(name, files);
    if (problem) {
      const key = `${name}@${version}`;
      if (!reportedProblems.has(key)) {
        reportedProblems.add(key);
        console.warn(`[skills] not delivering "${name}": ${problem}`);
      }
      continue;
    }
    out.push({ name, version, files, meta: skillMetaOf(files) });
  }
  return out;
}

function requireActive(name: string, dir: string): string {
  const root = skillDir(name, dir);
  if (!fs.existsSync(root)) {
    if (fs.existsSync(archivedDir(name, dir))) throw new Error(`"${name}" is archived; restore it first with \`talkcode skills restore ${name}\``);
    throw new Error(`no skill named "${name}"; \`talkcode skills list\` shows them`);
  }
  return root;
}

/**
 * Every recorded change to a skill, newest first: the gateway's commits and anyone else's, over
 * both places the skill can be (`skills/`, `archive/`). Each entry's `id` is the commit.
 */
export function skillHistory(name: string, dir = configDir()): SkillHistoryEntry[] {
  const clean = validateSkillName(name);
  const root = repoRoot(dir);
  if (!isRepo(root)) return [];
  return logPaths(root, skillPaths(clean)).map((e) => ({
    id: e.id,
    at: e.at,
    action: e.action ?? 'commit',
    author: e.author,
    ...(e.beforeVersion ? { beforeVersion: e.beforeVersion } : {}),
    ...(e.afterVersion ? { afterVersion: e.afterVersion } : {}),
    ...(e.note ? { note: e.note } : {}),
  }));
}

export interface CreateSkillInput {
  name: string;
  description: string;
  body?: string;
  source?: SkillSource;
  /** A line for the commit — the review's reason, when there is one. */
  note?: string;
  /** Who is writing; an agent through `talkcode skills` when absent. */
  by?: SkillChangeBy;
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
  ensureRepo(dir);
  const now = input.now ?? Date.now();
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
  commit(dir, name, { action: 'create', note: input.note, after: skillVersion(name, dir), by: input.by, now });
  return recordOf(name, usage.skills[name]!, readSkillFiles(name, dir), false, now);
}

export interface PatchSkillInput {
  name: string;
  version: string;
  content: string;
  /** A line for the commit — the review's reason, when there is one. */
  note?: string;
  by?: SkillChangeBy;
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
  const nextMeta = skillMetaOf(next);
  assertResidentUnchanged(skillMetaOf(files), nextMeta, input.by);
  assertResidentDescription(nextMeta, input.content);
  ensureRepo(dir);
  const after = skillVersionOf(next);
  const now = input.now ?? Date.now();
  writeAtomic(path.join(skillDir(name, dir), SKILL_FILE), input.content, 0o600);
  commit(dir, name, { action: 'patch', note: input.note, before: current, after, by: input.by, now });
  // Editing is not use: a skill already expired stays expired, and a patch does not reset its clock.
  return recordOf(name, readUsage(dir).skills[name] ?? defaultUsage(name, dir), next, false, now);
}

export interface WriteFileInput {
  name: string;
  file: string;
  content: string;
  /** A line for the commit — the review's reason, when there is one. */
  note?: string;
  by?: SkillChangeBy;
  now?: number;
}

/** Write one reference, template or script. */
export function writeSkillFile(input: WriteFileInput, dir = configDir()): SkillRecord {
  const name = validateSkillName(input.name);
  const rel = validateFilePath(input.file);
  requireActive(name, dir);
  const bytes = Buffer.byteLength(input.content);
  if (bytes > MAX_EXTRA_BYTES) throw new Error(`${rel} is ${bytes} bytes, over the ${MAX_EXTRA_BYTES}-byte limit`);
  ensureRepo(dir);
  const files = readSkillFiles(name, dir);
  const before = skillVersionOf(files);
  const next = new Map(files);
  next.set(rel, Buffer.from(input.content));
  const after = skillVersionOf(next);
  const now = input.now ?? Date.now();
  writeAtomic(path.join(skillDir(name, dir), ...rel.split('/')), input.content, rel.startsWith('scripts/') ? 0o700 : 0o600);
  commit(dir, name, { action: 'write-file', note: input.note ? `${rel} — ${input.note}` : rel, before, after, by: input.by, now });
  return recordOf(name, readUsage(dir).skills[name] ?? defaultUsage(name, dir), next, false, now);
}

/** Remove one extra file. `SKILL.md` is not removable; archive the skill instead. */
export function removeSkillFile(
  input: { name: string; file: string; note?: string; by?: SkillChangeBy; now?: number },
  dir = configDir()
): SkillRecord {
  const name = validateSkillName(input.name);
  const rel = validateFilePath(input.file);
  requireActive(name, dir);
  const files = readSkillFiles(name, dir);
  if (!files.has(rel)) throw new Error(`"${name}" has no file ${rel}`);
  ensureRepo(dir);
  const before = skillVersionOf(files);
  const next = new Map(files);
  next.delete(rel);
  const after = skillVersionOf(next);
  const now = input.now ?? Date.now();
  fs.rmSync(path.join(skillDir(name, dir), ...rel.split('/')), { force: true });
  pruneEmptyDirs(path.dirname(path.join(skillDir(name, dir), ...rel.split('/'))), skillDir(name, dir));
  commit(dir, name, { action: 'remove-file', note: input.note ? `${rel} — ${input.note}` : rel, before, after, by: input.by, now });
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

/** Move a skill into `archive/` — never delete it. */
export function archiveSkill(name: string, dir = configDir(), now = Date.now(), by: SkillChangeBy = AGENT): SkillRecord {
  const clean = validateSkillName(name);
  const active = skillDir(clean, dir);
  const archived = archivedDir(clean, dir);
  if (!fs.existsSync(active)) {
    if (fs.existsSync(archived)) {
      return recordOf(clean, readUsage(dir).skills[clean] ?? defaultUsage(clean, dir), readAllFiles(archived), true, now);
    }
    throw new Error(`no skill named "${clean}"`);
  }
  ensureRepo(dir);
  const version = skillVersion(clean, dir);
  fs.mkdirSync(archiveRoot(dir), { recursive: true, mode: 0o700 });
  fs.renameSync(active, archived);
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  usage.skills[clean] = { ...rec, status: 'archived', archivedAt: iso(now) };
  writeUsage(usage, dir);
  commit(dir, clean, { action: 'archive', before: version, by, now });
  return recordOf(clean, usage.skills[clean]!, readAllFiles(archived), true, now);
}

/** Bring an archived skill back, with its clock reset so the next sweep leaves it alone. */
export function restoreSkill(name: string, dir = configDir(), now = Date.now(), by: SkillChangeBy = AGENT): SkillRecord {
  const clean = validateSkillName(name);
  const active = skillDir(clean, dir);
  const archived = archivedDir(clean, dir);
  if (fs.existsSync(active)) throw new Error(`"${clean}" is already active`);
  if (!fs.existsSync(archived)) throw new Error(`no archived skill named "${clean}"`);
  ensureRepo(dir);
  fs.mkdirSync(skillsRoot(dir), { recursive: true, mode: 0o700 });
  fs.renameSync(archived, active);
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  const { archivedAt: _archivedAt, ...rest } = rec;
  usage.skills[clean] = { ...rest, status: 'active', restoredAt: iso(now) };
  writeUsage(usage, dir);
  commit(dir, clean, { action: 'restore', after: skillVersion(clean, dir), by, now });
  return recordOf(clean, usage.skills[clean]!, readSkillFiles(clean, dir), false, now);
}

/** Pin or unpin. A hand-written skill has no usage record yet; pinning one gives it one. */
export function pinSkill(name: string, pinned: boolean, dir = configDir()): SkillRecord {
  const clean = validateSkillName(name);
  if (!fs.existsSync(skillDir(clean, dir)) && !fs.existsSync(archivedDir(clean, dir))) {
    throw new Error(`no skill named "${clean}"`);
  }
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  usage.skills[clean] = { ...rec, pinned };
  writeUsage(usage, dir);
  const archived = !fs.existsSync(skillDir(clean, dir));
  const files = archived ? readAllFiles(archivedDir(clean, dir)) : readSkillFiles(clean, dir);
  return recordOf(clean, usage.skills[clean]!, files, archived, Date.now());
}

/**
 * Put a skill in every agent's context (resident) or take it out to the library. A person's
 * choice: the web UI's page calls this, and there is no reverse command for it — see
 * `assertResidentUnchanged`. Going resident is refused while the description is too long for it.
 */
export function setResident(name: string, resident: boolean, dir = configDir(), now = Date.now(), by: SkillChangeBy = { kind: 'person' }): SkillRecord {
  const clean = validateSkillName(name);
  requireActive(clean, dir);
  const files = readSkillFiles(clean, dir);
  const md = files.get(SKILL_FILE)?.toString('utf8') ?? '';
  if (skillMetaOf(files).resident === resident) return recordOf(clean, readUsage(dir).skills[clean] ?? defaultUsage(clean, dir), files, false, now);
  const content = withResident(md, resident);
  assertSkillMd(content, clean);
  assertResidentDescription({ resident }, content);
  ensureRepo(dir);
  const before = skillVersionOf(files);
  const next = new Map(files);
  next.set(SKILL_FILE, Buffer.from(content));
  writeAtomic(path.join(skillDir(clean, dir), SKILL_FILE), content, 0o600);
  commit(dir, clean, { action: resident ? 'resident' : 'library', before, after: skillVersionOf(next), by, now });
  return recordOf(clean, readUsage(dir).skills[clean] ?? defaultUsage(clean, dir), next, false, now);
}

/** Mark a skill expired without moving it. Returns whether the stored status changed. */
export function markExpired(name: string, dir = configDir()): boolean {
  const usage = readUsage(dir);
  const rec = usage.skills[name];
  if (!rec || !canExpire(rec) || rec.status === 'expired') return false;
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

/**
 * Put back the files as they were just before one change in the skill's history, as a new commit.
 * The change can be anyone's — the gateway's or a person's — and the skill comes back active even
 * if it was archived, as it did when history was snapshots.
 */
export function revertSkill(name: string, id: string, dir = configDir(), now = Date.now(), by: SkillChangeBy = AGENT): RevertResult {
  const clean = validateSkillName(name);
  const root = repoRoot(dir);
  const history = skillHistory(clean, dir);
  const full = isRepo(root) ? resolveCommit(root, id.trim()) : undefined;
  const entry = full ? history.find((e) => full.startsWith(e.id)) : undefined;
  if (!full || !entry) throw new Error(`"${clean}" has no history entry ${id}; \`talkcode skills history ${clean}\` lists them`);
  const parent = parentOf(root, full);
  const target = parent ? beforeFiles(root, parent, clean) : new Map<string, Buffer>();
  if (!target.has(SKILL_FILE)) {
    throw new Error(`history entry ${id} is the skill's first version; there is nothing before it to restore`);
  }
  const active = skillDir(clean, dir);
  const archived = archivedDir(clean, dir);
  const currentDir = fs.existsSync(active) ? active : fs.existsSync(archived) ? archived : undefined;
  if (!currentDir) throw new Error(`no skill named "${clean}"`);
  const before = skillVersionOf(readAllFiles(currentDir));
  const after = skillVersionOf(target);
  // Built beside the repository, then swapped in: a crash halfway leaves the old skill whole.
  const tmp = path.join(dir, `.skill-revert-${clean}-${process.pid}-${randomBytes(3).toString('hex')}`);
  for (const [rel, data] of target) {
    const dest = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, data, { mode: rel.startsWith('scripts/') ? 0o700 : 0o600 });
  }
  fs.rmSync(currentDir, { recursive: true, force: true });
  if (fs.existsSync(archived)) fs.rmSync(archived, { recursive: true, force: true });
  fs.mkdirSync(skillsRoot(dir), { recursive: true, mode: 0o700 });
  fs.renameSync(tmp, active);
  const usage = readUsage(dir);
  const rec = usage.skills[clean] ?? defaultUsage(clean, dir);
  const { archivedAt: _archivedAt, ...rest } = rec;
  usage.skills[clean] = { ...rest, status: 'active', restoredAt: iso(now) };
  writeUsage(usage, dir);
  commit(dir, clean, { action: 'revert', note: `revert ${entry.id}`, before, after, by, now });
  const logged = skillHistory(clean, dir)[0] ?? entry;
  return { skill: recordOf(clean, usage.skills[clean]!, readSkillFiles(clean, dir), false, now), entry: logged };
}

/** The delivered files of a skill as of `rev`, wherever it was then (active or archived). */
function beforeFiles(root: string, rev: string, name: string): Map<string, Buffer> {
  for (const place of skillPaths(name)) {
    const files = filesAt(root, rev, place);
    if (files.has(SKILL_FILE)) {
      return new Map([...files].filter(([rel]) => rel === SKILL_FILE || EXTRA_DIRS.some((d) => rel.startsWith(`${d}/`))));
    }
  }
  return new Map();
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
