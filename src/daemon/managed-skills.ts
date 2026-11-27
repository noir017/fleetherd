import fs from 'node:fs';
import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { AgentProvision, HostFiles } from './provision.js';
import { selfInvocation } from './reverse-cli-shim.js';
import { syncSkillCopy } from './skill-copy.js';
import { allSkillDirs, linkSkill, removeSkillLink, skillHomes } from './skill-link.js';
import { activeSkillFiles, archivedSkillNames, skillReaches, type SkillFileSet } from './skills-store.js';
import { envOf } from '../legacy-name.js';

/**
 * Delivering the gateway's managed skills to the machine an agent runs on.
 *
 * Each spawn (local `agent-common.ts` `buildAgentEnv`, remote `remote-hosts.ts` `placeManagedSkills`)
 * copies the active skills to `<home>/.fleetherd/skills/<name>/` and links each one into the
 * directories that harness reads skills from (`skill-link.ts`). The copy is read-only, so an agent
 * that wants a change has to go through `fleetherd skills` — where it is versioned and can be
 * reverted — rather than editing the copy and having the next spawn silently overwrite it.
 *
 * ── What it will and will not touch ─────────────────────────────────────────────────────────────
 * The copy lives in a directory of the gateway's own (`~/.fleetherd/skills`), so it is replaced
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

/**
 * The harness as a skill's `fleetherd-harnesses` names it: the harness, except CodeBuddy, which runs
 * as a `custom` agent and is told apart by its command (the reading skillHomes gives it too).
 */
export function skillHarnessOf(def: AgentDef): string {
  return def.harness === 'custom' && path.basename(def.command ?? '') === 'codebuddy' ? 'codebuddy' : def.harness;
}

/** Whether `def` gets `skill` at all — its `fleetherd-hosts` / `fleetherd-harnesses`, if any. */
export function deliveredTo(skill: SkillFileSet, def: AgentDef): boolean {
  return skillReaches(skill.meta, def.host ?? 'local', skillHarnessOf(def));
}

/** The directory on a host that holds the copies; also what makes a link "ours". */
export function managedSkillsHome(home: string): string {
  return path.join(home, '.fleetherd', 'skills');
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
    if (!deliveredTo(skill, def)) continue;
    const copy = path.join(owned, skill.name);
    const files = syncSkillCopy(copy, skill.files);
    results.push({ name: skill.name, path: copy, ...files });
    if (files.outcome === 'failed') continue;
    // A library skill is on disk for the search to point at, never linked: a link would put its
    // description in this agent's context, which is what the library tier exists to avoid. One
    // that was resident before has its links taken back, in every directory a link could be in.
    if (!skill.meta.resident) {
      for (const d of allSkillDirs(home)) {
        const r = removeSkillLink(path.join(d, skill.name), owned);
        if (r.outcome !== 'skipped') results.push({ name: skill.name, path: r.link, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) });
      }
      continue;
    }
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

/** Problems already reported, so a spawn-time call does not repeat the warning. */
const warned = new Set<string>();

function report(r: ManagedResult): void {
  if (r.outcome === 'placed') console.log(`[skills] placed ${r.name} at ${r.path}`);
  else if (r.outcome === 'linked') console.log(`[skills] linked ${r.path} → ${r.source ?? ''}`);
  else if (r.outcome === 'relinked') console.log(`[skills] repointed ${r.path} → ${r.source ?? ''} (was ${r.detail})`);
  else if (r.outcome === 'removed') console.log(`[skills] took back ${r.path} (archived, or in the library now)`);
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
 * reach it, and FLEETHERD_NO_SKILL_LINK=1 keeps a test daemon off the live files.
 */
export function placeManagedSkills(def: AgentDef, home: string): ManagedResult[] {
  if (envOf('NO_SKILL_LINK')) return [];
  if (!selfInvocation()) return [];
  const results = applyManagedSkills(def, home);
  for (const r of results) report(r);
  return results;
}

/** Delete files the copy still has that this version no longer carries (always after writing). */
async function pruneManagedFiles(host: HostFiles, copy: string, skill: { files: Map<string, Buffer> }): Promise<void> {
  const have = await host.listFiles(copy);
  for (const rel of have) {
    if (skill.files.has(rel)) continue;
    await host.removePath(`${copy}/${rel}`, copy);
  }
}

async function linkManaged(host: HostFiles, copy: string, where: { dir: string; requires: string }, name: string, owned: string): Promise<string> {
  const r = await host.ensureLink(copy, `${where.dir}/${name}`, where.requires, owned);
  if (r.outcome === 'linked' || r.outcome === 'relinked') console.log(`[skills] ${host.id}: ${r.outcome} ${r.link} → ${copy}`);
  else if (r.outcome === 'occupied' || r.outcome === 'failed') {
    console.warn(`[skills] ${host.id}: ${r.link}: ${r.outcome} (${r.detail ?? ''}) — leaving it alone`);
  }
  return r.outcome;
}

async function unlinkManaged(
  host: HostFiles,
  dir: string,
  name: string,
  owned: string,
  why: 'archived' | 'in the library now'
): Promise<void> {
  const r = await host.removeLink(`${dir}/${name}`, owned);
  if (r.outcome === 'removed') console.log(`[skills] ${host.id}: took back ${r.link} (${why})`);
  else if (r.outcome === 'kept') console.warn(`[skills] ${host.id}: ${r.link} is ${r.detail ?? 'not ours'} — leaving it alone`);
}

/**
 * Managed skills provision (local + remote). Remote files and links are cached separately per
 * `host@instance@skill` and `host@instance@skill@dir`; archived skills are retired once per instance.
 */
export function createManagedSkillsProvision(dir?: string): AgentProvision<ManagedResult[], void> {
  const managedFiles = new Map<string, string>();
  const managedLinks = new Map<string, string>();
  const managedArchived = new Set<string>();

  async function unlinkLibrarySkill(host: HostFiles, home: string, key: string, name: string, owned: string): Promise<void> {
    for (const d of allSkillDirs(home)) {
      const linkKey = `${key}@${d}`;
      if (managedLinks.get(linkKey) === 'absent') continue;
      try {
        await unlinkManaged(host, d, name, owned, 'in the library now');
        managedLinks.set(linkKey, 'absent');
      } catch (e) {
        console.warn(`[skills] ${host.id}: could not take back "${name}" from ${d}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  async function placeActiveManagedSkills(host: HostFiles, def: AgentDef, home: string, owned: string, w: Welcome): Promise<void> {
    const homes = skillHomes(def.harness, home, def.command);
    for (const skill of activeSkillFiles(dir)) {
      if (!deliveredTo(skill, def)) continue;
      const key = `${host.id}@${w.instance}@${skill.name}`;
      managedArchived.delete(key);
      const copy = `${owned}/${skill.name}`;
      try {
        if (managedFiles.get(key) !== skill.version) {
          for (const [rel, data] of skill.files) {
            await host.writeFile(`${copy}/${rel}`, data, rel.startsWith('scripts/') ? 0o555 : 0o444, { atomic: true });
          }
          await pruneManagedFiles(host, copy, skill);
          managedFiles.set(key, skill.version);
        }
      } catch (e) {
        console.warn(`[skills] ${host.id}: could not place "${skill.name}":`, e instanceof Error ? e.message : e);
        continue;
      }
      if (!skill.meta.resident) {
        await unlinkLibrarySkill(host, home, key, skill.name, owned);
        continue;
      }
      for (const h of homes) {
        const linkKey = `${key}@${h.dir}`;
        if (managedLinks.get(linkKey) === 'linked' || managedLinks.get(linkKey) === 'occupied') continue;
        try {
          const outcome = await linkManaged(host, copy, h, skill.name, owned);
          if (outcome === 'linked' || outcome === 'relinked' || outcome === 'current') managedLinks.set(linkKey, 'linked');
          else if (outcome === 'occupied') managedLinks.set(linkKey, 'occupied');
        } catch (e) {
          console.warn(`[skills] ${host.id}: could not link "${skill.name}" for ${h.dir}:`, e instanceof Error ? e.message : e);
        }
      }
    }
  }

  async function retireManagedSkills(host: HostFiles, home: string, owned: string, w: Welcome): Promise<void> {
    for (const name of archivedSkillNames(dir)) {
      const key = `${host.id}@${w.instance}@${name}`;
      if (managedArchived.has(key)) continue;
      try {
        for (const d of allSkillDirs(home)) {
          await unlinkManaged(host, d, name, owned, 'archived');
          managedLinks.set(`${key}@${d}`, 'absent');
        }
        await host.removePath(`${owned}/${name}`, owned);
        managedFiles.set(key, 'absent');
        managedArchived.add(key);
      } catch (e) {
        console.warn(`[skills] ${host.id}: could not take back archived "${name}":`, e instanceof Error ? e.message : e);
      }
    }
  }

  return {
    name: 'managed-skills',
    local: (def, home) => placeManagedSkills(def, home),
    remote: async (host, def, home, w) => {
      if (envOf('NO_SKILL_LINK')) return;
      const owned = managedSkillsHome(home);
      await placeActiveManagedSkills(host, def, home, owned, w);
      await retireManagedSkills(host, home, owned, w);
    },
  };
}

export const managedSkillsProvision = createManagedSkillsProvision();
