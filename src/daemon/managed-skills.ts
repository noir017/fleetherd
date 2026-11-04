import fs from 'node:fs';
import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import { selfInvocation } from './reverse-cli-shim.js';
import { allSkillDirs, linkSkill, removeSkillLink, skillHomes } from './skill-link.js';
import { activeSkillFiles, archivedSkillNames, type SkillFileSet } from './skills-store.js';

/**
 * Delivering the gateway's managed skills to the machine an agent runs on.
 *
 * Each spawn (local `agent-common.ts` `buildAgentEnv`, remote `remote-hosts.ts` `placeManagedSkills`)
 * copies the active skills to `<home>/.talkcode/skills/<name>/` and links each one into the
 * directories that harness reads skills from (`skill-link.ts`). The copy is read-only, so an agent
 * that wants a change has to go through `talkcode skills` — where it is versioned and can be
 * reverted — rather than editing the copy and having the next spawn silently overwrite it.
 *
 * ── What it will and will not touch ─────────────────────────────────────────────────────────────
 * The copy lives in a directory of the gateway's own (`~/.talkcode/skills`), so it is replaced
 * whole when a version changes. A link is repointed only when it points inside that directory; a
 * real directory, a real file, or a link of the operator's own at `~/.claude/skills/<name>` is left
 * alone and logged. That is the same rule the bundled skills follow, tightened with `owned` because
 * a managed skill's name is arbitrary and may well collide with something the operator installed.
 *
 * Archived skills are taken back: their copy and every link of ours into it are removed on the
 * next spawn, in every directory a link could be in — not only the harness being spawned, since a
 * link made for another harness outlives this spawn.
 *
 * An unchanged version is not rewritten: local files are compared byte for byte, and the remote
 * side remembers the version it delivered per host and instance.
 */

/** The directory on a host that holds the copies; also what makes a link "ours". */
export function managedSkillsHome(home: string): string {
  return path.join(home, '.talkcode', 'skills');
}

export type ManagedOutcome = 'placed' | 'current' | 'linked' | 'relinked' | 'removed' | 'occupied' | 'skipped' | 'failed';

export interface ManagedResult {
  name: string;
  path: string;
  outcome: ManagedOutcome;
  detail?: string;
  /** The copy a link points at (link outcomes only). */
  source?: string;
}

/** Copy `files` into `copy`, touching only what changed. No guard — the tests drive this directly. */
export function applyManagedSkills(def: AgentDef, home: string, dir?: string): ManagedResult[] {
  const owned = managedSkillsHome(home);
  const results: ManagedResult[] = [];
  for (const skill of activeSkillFiles(dir)) {
    const copy = path.join(owned, skill.name);
    const files = syncFiles(copy, skill);
    results.push({ name: skill.name, path: copy, ...files });
    if (files.outcome === 'failed') continue;
    for (const h of skillHomes(def.harness, home, def.command)) {
      const r = linkSkill(copy, h, skill.name, owned);
      results.push({ name: skill.name, path: r.link, source: copy, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) });
    }
  }
  for (const name of archivedSkillNames(dir)) {
    const copy = path.join(owned, name);
    try {
      if (fs.existsSync(copy)) fs.rmSync(copy, { recursive: true, force: true });
    } catch (e) {
      results.push({ name, path: copy, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) });
    }
    for (const d of allSkillDirs(home)) {
      const r = removeSkillLink(path.join(d, name), owned);
      if (r.outcome !== 'skipped') results.push({ name, path: r.link, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) });
    }
  }
  return results;
}

/** Keep `copy` exactly equal to `files` (which is SKILL.md plus the three directories). */
function syncFiles(copy: string, skill: SkillFileSet): { outcome: ManagedOutcome; detail?: string } {
  try {
    let changed = false;
    try {
      if (fs.lstatSync(copy).isSymbolicLink()) fs.rmSync(copy, { force: true });
    } catch {
      // not there yet
    }
    for (const [rel, data] of skill.files) {
      const dest = path.join(copy, ...rel.split('/'));
      try {
        if (fs.readFileSync(dest).equals(data)) continue;
      } catch {
        // missing, or a directory where a file belongs: write it
      }
      writeAtomic(dest, data, rel.startsWith('scripts/') ? 0o555 : 0o444);
      changed = true;
    }
    for (const rel of walk(copy)) {
      if (skill.files.has(rel)) continue;
      fs.rmSync(path.join(copy, ...rel.split('/')), { force: true });
      changed = true;
    }
    return { outcome: changed ? 'placed' : 'current' };
  } catch (e) {
    return { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

function walk(dir: string, prefix = ''): string[] {
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
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

function writeAtomic(file: string, data: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/** Problems already reported, so a spawn-time call does not repeat the warning. */
const warned = new Set<string>();

function report(r: ManagedResult): void {
  if (r.outcome === 'placed') console.log(`[skills] placed ${r.name} at ${r.path}`);
  else if (r.outcome === 'linked') console.log(`[skills] linked ${r.path} → ${r.source ?? ''}`);
  else if (r.outcome === 'relinked') console.log(`[skills] repointed ${r.path} → ${r.source ?? ''} (was ${r.detail})`);
  else if (r.outcome === 'removed') console.log(`[skills] took back ${r.path} (archived)`);
  else if (r.outcome === 'occupied' || r.outcome === 'failed') {
    const key = `${r.path}:${r.outcome}:${r.detail ?? ''}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(
      r.outcome === 'occupied'
        ? `[skills] ${r.path} is ${r.detail}, not a link — leaving it alone; that copy is what agents will read`
        : `[skills] could not place ${r.path}: ${r.detail}`
    );
  }
}

/**
 * Deliver the managed skills for one local agent's harness under `home`. Best-effort and guarded
 * like `placeInstructions`: it writes into the operator's directories, so a test worker must never
 * reach it, and TALKCODE_NO_SKILL_LINK=1 keeps a test daemon off the live files.
 */
export function placeManagedSkills(def: AgentDef, home: string): ManagedResult[] {
  if (process.env.TALKCODE_NO_SKILL_LINK) return [];
  if (!selfInvocation()) return [];
  const results = applyManagedSkills(def, home);
  for (const r of results) report(r);
  return results;
}
