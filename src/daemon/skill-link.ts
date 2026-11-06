import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDef } from '../config/schema.js';
import { selfInvocation } from './reverse-cli-shim.js';

/**
 * Puts the bundled skill (`skill/` at the package root) where each harness looks for skills, as a
 * symlink named `talkcode`.
 *
 * ── Why the daemon does this ──────────────────────────────────────────────────────────────────
 * The skill is how an agent learns what the gateway can do beyond its two native tools — posting to
 * other chats, history, threads, buttons — at the cost of one line of skill description, delivered
 * by the harness's own skill mechanism rather than by text the gateway writes into the conversation.
 * Shipping it inside the package and linking it from here means:
 *  - it appears only on machines that run this daemon (a shared skill repo would put it in front of
 *    agents on every machine that syncs the repo, where the `talkcode` command does not exist);
 *  - its content is always the running daemon's own — the link points into the installed package,
 *    so an upgrade updates the skill with nothing to re-copy.
 *
 * ── Where, per harness ────────────────────────────────────────────────────────────────────────
 * Probed, not assumed:
 *  - claude   — `<home>/.claude/skills` (its documented user-level location; skills-scan.ts).
 *  - codex    — `<home>/.agents/skills` (marker-skill experiment on codex-acp 1.12.0, skills-scan.ts).
 *  - agy      — `<home>/.gemini/config/skills`. Probed 2026-10-09 on agy 1.3.2 by asking the model
 *               to list its skills: a symlinked skill there was listed; the same link under
 *               `<home>/.gemini/antigravity-cli/skills` — the global directory agy's own help names —
 *               was not, and neither was anything in `<home>/.agents/skills` from a working
 *               directory outside home (skills-scan.ts reads that one only because a workspace that
 *               IS home would). Linking to the cross-vendor directory alone left agy without the
 *               skill: asked to send a picture, it wrote a markdown image of a local path instead.
 *  - opencode — `<home>/.agents/skills`. Probed 2026-10-09 on opencode 2.0.26 by planting marker
 *               skills under an isolated HOME and asking the model to list its skills: it named the
 *               ones in `~/.claude/skills`, `~/.agents/skills` and `~/.config/opencode/skills`, plus
 *               the project-level `.claude/`, `.agents/` and `.opencode/` ones. (Its `GET /api/skill`
 *               answered an empty list even with skills configured — not a usable probe.)
 *  - custom — only when the command is CodeBuddy Code: `<home>/.codebuddy/skills`, the same shape as
 *               claude's. A custom harness is whatever its command is (agent-menu.ts agentKindOf),
 *               so the command is what says whether there is a directory to link into; for any
 *               other command nothing is linked rather than a guess.
 *  - gemini, dsh — none known; nothing is linked rather than a guess.
 * `.agents/skills` is the cross-vendor location, so one link serves codex and opencode.
 *
 * CodeBuddy used to be left out entirely, and the operator linked it by hand into
 * `~/.talkcode/remote/<version>/skill` — a path this daemon deletes on upgrade. Nothing repointed
 * it, so the link died at the next upgrade and stayed dead (`~/.codebuddy/skills/talkcode` on both
 * hosts, 2026-11-03). It is mapped here now, which is also what makes the next spawn repoint it.
 *
 * Only for a harness that has been run here: the link is made when the harness's own config
 * directory exists, never by creating one — the same rule instructions.ts follows, for the same
 * reason (that would be this daemon inventing configuration for a product the operator may not use).
 * Called at every agent spawn, so a harness first logged in after the daemon started is picked up by
 * its next session rather than the next restart.
 *
 * ── What it will and will not touch ───────────────────────────────────────────────────────────
 * A symlink by that name is taken to be ours and is repointed when it points elsewhere — an older
 * install, or a test daemon run from a checkout. A real directory or file by that name is the
 * operator's, and is left alone with a warning: they may be maintaining their own copy on purpose.
 * Like the reverse-CLI shim it writes to a SHARED path, so it carries the same guard: nothing happens
 * unless this process really is the CLI (a vitest worker is not), and TALKCODE_NO_SKILL_LINK=1
 * turns it off for a test daemon that must not repoint the live one's link.
 */

/** The link's name, which is also the name harnesses list the skill under. */
export const SKILL_LINK_NAME = 'talkcode';

/**
 * Every skill the package ships: the link name each is listed under, and its directory at the
 * package root. `super` is `/super` (daemon/delegation.ts): a second skill rather than a page of the
 * first because it is invoked by name — a harness that turns skills into slash commands (Claude
 * Code) offers it as one — and its own directory rather than one inside `skill/`, because a harness
 * that finds skills by walking for SKILL.md (opencode reads several trees) would list it twice.
 */
export const BUNDLED_SKILLS: ReadonlyArray<{ name: string; dir: string }> = [
  { name: SKILL_LINK_NAME, dir: 'skill' },
  { name: 'super', dir: 'skill-super' },
];

/** A skill directory at the package root (default `skill/`): two levels above this file in `dist/daemon/` and `src/daemon/`. */
export function bundledSkillDir(dir = 'skill'): string {
  return fileURLToPath(new URL(`../../${dir}`, import.meta.url));
}

/** A skills directory to link into, and the harness config directory that must exist first. */
export interface SkillHome {
  dir: string;
  requires: string;
}

/** Where `harness` reads skills from under `home` (see the header for the evidence per arm). */
export function skillHomes(harness: AgentDef['harness'], home: string, command?: string): SkillHome[] {
  const shared = path.join(home, '.agents', 'skills');
  switch (harness) {
    case 'claude':
      return [{ dir: path.join(home, '.claude', 'skills'), requires: path.join(home, '.claude') }];
    case 'codex':
      return [{ dir: shared, requires: path.join(home, '.codex') }];
    case 'agy':
      return [{ dir: path.join(home, '.gemini', 'config', 'skills'), requires: path.join(home, '.gemini', 'antigravity-cli') }];
    case 'opencode':
      return [{ dir: shared, requires: path.join(home, '.config', 'opencode') }];
    case 'gemini':
    case 'dsh':
      return [];
    case 'custom':
      // CodeBuddy Code, by the last segment of its command (`/usr/local/bin/codebuddy`), the same
      // reading agentKindOf gives it. Its skills live in its own directory, not `.agents/skills`.
      return path.basename(command ?? '') === 'codebuddy'
        ? [{ dir: path.join(home, '.codebuddy', 'skills'), requires: path.join(home, '.codebuddy') }]
        : [];
    default: {
      const _exhaustive: never = harness;
      return _exhaustive;
    }
  }
}

/**
 * Every directory a skill of ours could have been linked into under `home` — what a sweep of dead
 * links has to look at. The union, not the one harness being spawned: a link made by a version that
 * still mapped a harness outlives the mapping, and nothing else would ever look at it again.
 */
export function allSkillDirs(home: string): string[] {
  const mapped: AgentDef['harness'][] = ['claude', 'codex', 'agy', 'opencode'];
  const dirs = mapped.flatMap((h) => skillHomes(h, home).map((s) => s.dir));
  dirs.push(...skillHomes('custom', home, 'codebuddy').map((s) => s.dir));
  return [...new Set(dirs)];
}

export type SkillLinkOutcome = 'linked' | 'relinked' | 'current' | 'occupied' | 'skipped' | 'failed' | 'removed';

export interface SkillLinkResult {
  link: string;
  outcome: SkillLinkOutcome;
  /** What was there before (`relinked`), what is in the way (`occupied`), or the error (`failed`). */
  detail?: string;
}

function isUnder(dest: string, dir: string): boolean {
  return path.resolve(dest).startsWith(path.resolve(dir) + path.sep);
}

/**
 * Make `<home.dir>/<name>` a symlink to `source`. No guard — the tests drive this directly.
 *
 * With `owned`, an existing symlink is repointed only when it points inside that directory — the
 * rule the remote side already follows (remote/ops.go opEnsureLink) and the managed skills need:
 * `~/.claude/skills/foo` may be the operator's own link to their own copy, which is not ours to
 * replace just because a managed skill has the same name. Without `owned`, any symlink is treated
 * as ours, which is what the two bundled skills have always done.
 */
export function linkSkill(source: string, home: SkillHome, name = SKILL_LINK_NAME, owned?: string): SkillLinkResult {
  const link = path.join(home.dir, name);
  try {
    if (!fs.existsSync(home.requires)) return { link, outcome: 'skipped', detail: `${home.requires} does not exist` };
    let previous: string | undefined;
    try {
      const st = fs.lstatSync(link);
      if (!st.isSymbolicLink()) return { link, outcome: 'occupied', detail: st.isDirectory() ? 'a directory' : 'a file' };
      previous = fs.readlinkSync(link);
      const dest = path.resolve(home.dir, previous);
      if (dest === source) return { link, outcome: 'current' };
      if (owned && !isUnder(dest, owned)) return { link, outcome: 'occupied', detail: `a link to ${previous}` };
      fs.unlinkSync(link);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    fs.mkdirSync(home.dir, { recursive: true });
    fs.symlinkSync(source, link, 'dir');
    return previous === undefined ? { link, outcome: 'linked' } : { link, outcome: 'relinked', detail: previous };
  } catch (e) {
    return { link, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Take back a skill link only if it is a symlink pointing inside `owned` (managed skills). */
export function removeSkillLink(link: string, owned: string): SkillLinkResult {
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return { link, outcome: 'occupied', detail: st.isDirectory() ? 'a directory' : 'a file' };
    const previous = fs.readlinkSync(link);
    if (!isUnder(path.resolve(path.dirname(link), previous), owned)) {
      return { link, outcome: 'occupied', detail: `a link to ${previous}` };
    }
    fs.unlinkSync(link);
    return { link, outcome: 'removed', detail: previous };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { link, outcome: 'skipped', detail: 'nothing there' };
    return { link, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Links already reported as occupied or failed, so a spawn-time call does not repeat the warning. */
const warned = new Set<string>();

/**
 * Link the bundled skills for one agent's harness under `home`. Best-effort: every outcome is logged
 * or silent, never thrown — an agent without the skills still has its tools and its shell.
 */
export function ensureSkillLink(harness: AgentDef['harness'], home: string, command?: string): SkillLinkResult[] {
  if (process.env.TALKCODE_NO_SKILL_LINK) return [];
  if (!selfInvocation()) return [];
  const results: SkillLinkResult[] = [];
  for (const skill of BUNDLED_SKILLS) {
    const source = bundledSkillDir(skill.dir);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
      if (!warned.has(source)) console.warn(`[skill] no bundled skill at ${source}; agents will not get it`);
      warned.add(source);
      continue;
    }
    for (const r of skillHomes(harness, home, command).map((h) => linkSkill(source, h, skill.name))) {
      results.push(r);
      report(r, source);
    }
  }
  return results;
}

/** Say what one link came to: a change once, a problem once per link, an unchanged link not at all. */
function report(r: SkillLinkResult, source: string): void {
  if (r.outcome === 'linked') console.log(`[skill] linked ${r.link} → ${source}`);
  else if (r.outcome === 'relinked') console.log(`[skill] repointed ${r.link} → ${source} (was ${r.detail})`);
  else if ((r.outcome === 'occupied' || r.outcome === 'failed') && !warned.has(r.link)) {
    warned.add(r.link);
    console.warn(
      r.outcome === 'occupied'
        ? `[skill] ${r.link} is ${r.detail}, not a link — leaving it alone; that copy is what agents will read`
        : `[skill] could not link ${r.link}: ${r.detail}`
    );
  }
}
