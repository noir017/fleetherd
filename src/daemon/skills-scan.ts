import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentDef } from '../config/schema.js';
import type { RemoteHost } from '../remote/host.js';
import { HARNESSES } from './harness/index.js';

/**
 * Where a harness keeps the skills its operator installed, read straight off disk.
 *
 * ── Why not ask the agent ─────────────────────────────────────────────────────
 * `/skills` first answered from `available_commands_update`, which a harness pushes when it BUILDS
 * a session (session/new, /load, /resume, /fork). That list is authoritative, and it is also
 * unavailable exactly when a user wants it: the daemon holds it in memory, so every restart empties
 * it, and the first `/skills` after an update reports nothing until some conversation happens to
 * run a turn. Observed 2026-09-11, immediately after deploying the feature — asked in a fresh
 * Telegram topic, it answered "claude has not reported any commands."
 *
 * Disk has neither problem. It is readable before any agent has ever started, it survives a
 * restart, and it costs one readdir per configured directory.
 *
 * The tradeoff taken knowingly: this reads another tool's private layout, so a harness that moves
 * its skills directory silently empties the catalogue. That is why every path below is justified by
 * something observed on this machine rather than assumed, why an unreadable directory degrades to
 * "no skills" instead of failing the command, and why the catalogue says which directories it read.
 *
 * ── What counts as a skill ────────────────────────────────────────────────────
 * A directory containing `SKILL.md`. Both harnesses here use that exact shape, and the entries are
 * often SYMLINKS into a shared tree (25 of the 26 under `~/.claude/skills` point at
 * `~/agent-skills-visible/`), so every check follows links — `stat`, never `lstat`.
 *
 * Deliberately NOT included: the harness's own bundled commands. claude reports 65 commands of
 * which only 26 are installed skills; the rest (`/compact`, `/deep-research`, …) ship with the
 * product and are reachable from the gateway menu or the harness picker. "The skills I configured"
 * is what was asked for and is also the only part disk can answer honestly.
 */

/** A skill found on disk: the name a user would type, and where it came from. */
export interface FoundSkill {
  name: string;
  dir: string;
}

/**
 * Directories to scan, in the order their entries should be listed.
 *
 * Pure, so the per-harness knowledge is testable without a filesystem. `configured` carries the
 * paths that can only be learned by reading the harness's own config file (opencode's `skills`
 * array); everything else is convention.
 *
 * Per harness, and why:
 *  - claude   — `<home>/.claude/skills`, the documented user-level location, confirmed here with 26
 *               entries matching what the harness reports. The project-level `<cwd>/.claude/skills`
 *               is scanned too, because the conversation's directory is a `/cd` choice and a
 *               project's own skills are exactly the ones relevant to the work being asked for.
 *  - opencode — no convention is assumed: it reads whatever `skills` names in `opencode.json`
 *               (`/home/user/agent-skills/skills` here). Passed in as `configured`.
 *  - codex    — four: `<home>/.codex/skills`, `<home>/.agents/skills`, and the same two under the
 *               conversation's own directory. Established by experiment on codex-acp 1.12.0
 *               (2026-09-20), not by analogy: a uniquely-named marker skill was planted under each
 *               candidate inside an isolated `HOME`, and the adapter's own
 *               available_commands_update read back (it publishes every skill as `$name`). All four
 *               came back; `<home>/.claude/skills` planted the same way did NOT, so codex does not
 *               read claude's tree even though both use the SKILL.md shape.
 *
 *               `.agents/skills` is the one that matters and the one easiest to miss. On this
 *               machine `~/.codex/skills` holds nothing but `.system` — codex's own six bundled
 *               skills, which this file excludes on principle — while the operator's 25 live in
 *               `~/.agents/skills`, the cross-vendor location agy already scans. A codex arm
 *               listing only the `.codex` paths therefore reports an empty catalogue on a machine
 *               that visibly has skills, which is exactly the confident-but-wrong answer the header
 *               warns about. (`.system` needs no special-casing: it holds one directory per skill
 *               rather than a SKILL.md of its own, so the scan below already passes over it.)
 *
 *               `$CODEX_HOME/skills` is read too — same marker, same result — and is deliberately
 *               NOT scanned. It is the same directory as `<home>/.codex/skills` whenever CODEX_HOME
 *               is unset, which is the normal case, and when it is set it is set in the agent's
 *               `env` block, where `agentHome` already gives that operator a supported way to move
 *               the whole tree.
 *  - agy      — five locations, which is agy's own layout rather than a guess: its "Create new
 *               skills" help names a workspace dir (`<workspace>/.agents/skills`), a global one
 *               (`<home>/.gemini/antigravity-cli/skills`) and a shared one (`<home>/.gemini/skills`),
 *               and `<home>/.gemini/config/skills` was found holding an installed skill that
 *               `agy -p /skills` lists. `<home>/.agents/skills` is scanned alongside the workspace
 *               path because an operator whose trusted workspace IS their home writes skills there
 *               and a `/cd` elsewhere must not hide them. Probed on agy 1.2.0 (2026-09-17): a skill
 *               under the home path and one under the conversation's own directory both expand when
 *               typed. Which wins when both define a name was NOT probed; the project's own copy is
 *               listed first because it is the more specific of the two.
 *  - dsh      — none. Nothing has been found for it, and inventing a path would produce a
 *               confidently empty list rather than an honest one.
 *
 * agy's bundled skills (`<home>/.gemini/antigravity-cli/builtin/skills` — `generative_ui`,
 * `antigravity-guide`, …) are deliberately left out, for the reason in this file's header: what was
 * asked for is the skills the operator installed, not what shipped with the product.
 *
 * Asking agy instead was tried and is not an option: `agy -p /skills` answers in 6 entries here
 * (its 5 builtins plus the one under `.gemini/config/skills`) and omits all 25 under
 * `~/.agents/skills` — skills it nonetheless expands when typed. Disk is the honest source.
 */
export function skillDirsFor(
  def: AgentDef | undefined,
  opts: { home: string; cwd: string; configured?: readonly string[] }
): string[] {
  const dirs = def ? HARNESSES[def.harness].skillScanDirs(opts) : [];
  // A conversation that never used /cd sits in the agent's own cwd, so a harness's home-level and
  // project-level paths can be the same directory (claude's two, agy's first two — and on a machine
  // whose trusted workspace is the home directory, agy's are the same path by construction);
  // listing it twice would duplicate every skill in it.
  return [...new Set(dirs)];
}

/**
 * The `skills` array from opencode's config, or nothing.
 *
 * Located by opencode's own resolution order as observed here (`$XDG_CONFIG_HOME` or `~/.config`,
 * then `opencode.json`). Any failure — absent file, malformed JSON, a `skills` key that is not an
 * array of strings — yields no directories rather than throwing: this runs inside a chat command,
 * and a broken config elsewhere should degrade the catalogue, not the gateway.
 */
export async function opencodeSkillDirs(home: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const base = env['XDG_CONFIG_HOME'] || join(home, '.config');
  const file = join(base, 'opencode', 'opencode.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const skills = (parsed as { skills?: unknown })?.skills;
    if (!Array.isArray(skills)) return [];
    return skills.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch (e) {
    // Absent is the common case (opencode not configured on this machine) and not worth a line.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[skills] could not read ${file}:`, e instanceof Error ? e.message : e);
    }
    return [];
  }
}

/**
 * Every skill under `dirs`, de-duplicated by name, first occurrence winning.
 *
 * First-wins matches how both harnesses resolve a shadowed skill: the earlier directory in their
 * own search order is the one that takes effect, and `skillDirsFor` returns them in that order. A
 * catalogue listing both copies would claim two commands where the user has one.
 *
 * A directory that cannot be read contributes nothing and is logged once. The common cause is that
 * it does not exist — a project with no `.claude/skills` — which is not a problem to report.
 */
export async function scanSkillDirs(dirs: readonly string[]): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[skills] could not list ${dir}:`, e instanceof Error ? e.message : e);
      }
      continue;
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (seen.has(name)) continue;
      // stat, not lstat: most entries here are symlinks into a shared skills tree, and an
      // lstat-based isDirectory() check would reject every one of them.
      const isSkill = await stat(join(dir, name, 'SKILL.md')).then(
        (s) => s.isFile(),
        () => false
      );
      if (!isSkill) continue;
      seen.add(name);
      found.push({ name, dir });
    }
  }
  return found;
}

/**
 * One shell pass over `dirs` on a remote host, printing `dir<TAB>name` for every entry holding a
 * SKILL.md. A listing plus a stat per entry would be a round trip each; this is one. The glob's
 * trailing slash matches directories and links to directories alike — the same leniency `stat`
 * gives the local scan.
 */
const REMOTE_SKILL_SCAN =
  'for d in "$@"; do [ -d "$d" ] || continue; for e in "$d"/*/; do [ -f "${e}SKILL.md" ] && printf "%s\\t%s\\n" "$d" "$(basename "$e")"; done; done; exit 0';

/** scanSkillDirs for an agent on a remote host: the same first-wins catalogue, read over there. */
export async function scanRemoteSkillDirs(host: RemoteHost, dirs: readonly string[]): Promise<FoundSkill[]> {
  if (dirs.length === 0) return [];
  const r = await host.run({ argv: ['sh', '-c', REMOTE_SKILL_SCAN, 'sh', ...dirs], timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.spawnError ?? r.stderr ?? `exit ${r.code ?? r.signal}`);
  const byDir = new Map<string, string[]>();
  for (const line of r.output.toString('utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const dir = line.slice(0, tab);
    byDir.set(dir, [...(byDir.get(dir) ?? []), line.slice(tab + 1)]);
  }
  const found: FoundSkill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of (byDir.get(dir) ?? []).sort((a, b) => a.localeCompare(b))) {
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({ name, dir });
    }
  }
  return found;
}

/** opencodeSkillDirs, reading opencode.json on the agent's host; `env` is the agent's own block. */
export async function remoteOpencodeSkillDirs(host: RemoteHost, home: string, env: Record<string, string>): Promise<string[]> {
  const file = join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'opencode', 'opencode.json');
  try {
    const parsed: unknown = JSON.parse((await host.readFile(file, 1 << 20)).toString('utf8'));
    const skills = (parsed as { skills?: unknown })?.skills;
    return Array.isArray(skills) ? skills.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  } catch {
    return [];
  }
}
