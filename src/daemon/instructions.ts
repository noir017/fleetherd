import fs from 'node:fs';
import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import { configDir } from '../config/load.js';
import { selfInvocation } from './reverse-cli-shim.js';

/**
 * The operator's standing instructions — how they want to be worked with — placed where each
 * agent's harness reads its USER-level instruction file, so that every agent on every host reads
 * the same words, kept in one place: `<configDir>/instructions/` on the gateway. Moving the gateway
 * moves them; nothing has to be copied host by host.
 *
 * ── Why the harness's own file, and not the prompt ───────────────────────────────────────────────
 * "Nothing of the gateway's in the agent's prompt" (AGENTS.md) still holds: this text is the
 * operator's, not the gateway's, and it reaches the agent through a mechanism every harness already
 * has — a file it reads at startup, ahead of any conversation, into the part of its context it keeps
 * cached. Not a word is added to it here: no header, no "managed by" line. And because it is a file
 * on the host rather than something sent with a turn, an agent started from a terminal on that host
 * reads it too.
 *
 * ── Two layers ────────────────────────────────────────────────────────────────────────────────────
 *   common.md   — for every agent
 *   <name>.md   — for one kind of agent: claude, codex, opencode, agy, codebuddy, atomcode
 * Joined in that order, the agent's own last so it can narrow what the common one says. The second
 * layer exists because some rules are about one harness's economics and mean nothing, or the wrong
 * thing, to another: the first one written (2026-11-04) tells Claude Code to start fewer sub-agents,
 * for the sake of its prompt cache — not a rule for agents billed differently.
 *
 * ── Where, per harness ────────────────────────────────────────────────────────────────────────────
 * Probed 2026-11-04 except where said: a symlink at the path below pointing to a file holding a
 * random word, the harness run in print mode from an empty directory outside any project, asked for
 * the word. The symlink is the probe because it is what ships.
 *  - claude   — `~/.claude/CLAUDE.md`, Claude Code's documented user memory file. Not probed.
 *  - codex    — `~/.codex/AGENTS.md` (codex 0.165.0). Its session file records it as an `agents_md`
 *               item. An `AGENTS.override.md` beside it takes precedence (the lookup order is in the
 *               binary), so an operator who has one keeps it — this never touches that name.
 *  - opencode — `~/.config/opencode/AGENTS.md` (opencode 2.2.5): its global rule file.
 *  - agy      — `~/.gemini/config/AGENTS.md` (agy, 2026-11-04 build). `~/.gemini/config` is agy's
 *               global customization root — where it reads skills (skill-link.ts) — and its built-in
 *               docs say a root may hold a standalone `GEMINI.md`/`AGENTS.md`, always active.
 *  - custom   — by command, as skill-link.ts reads it: CodeBuddy Code, `~/.codebuddy/CODEBUDDY.md`
 *               (2.179.2, its USER-scope memory file); AtomCode, `~/.atomcode/ATOMCODE.md` (v5.2.5,
 *               named "global … personal defaults" in its own help). Any other command: nothing.
 *  - gemini, dsh — none known; nothing is placed rather than a guess.
 * A harness's own override of its directory (CODEX_HOME, XDG_CONFIG_HOME) is not followed; an
 * `env.HOME` override is, by the caller, as for the skill.
 *
 * ── What it will and will not touch ──────────────────────────────────────────────────────────────
 * The text goes to `<home>/.talkcode/instructions/<name>.md` — a fixed path, never under a version
 * directory (an upgrade deletes those, and a link into one dies: skill-link.ts, CodeBuddy,
 * 2026-11-03) — written read-only and replaced in one rename, since agents may be starting and
 * reading it as it changes; read-only so an agent that wants to change it finds out it should not
 * (the next spawn would overwrite it). The harness's file becomes a symlink to that copy, under the
 * skill link's rules: only where the harness's config directory exists, never over a real file (the
 * operator's own, left alone with a warning) — and, stricter than the skill, a symlink is repointed
 * only when it points into `~/.talkcode/instructions`, because at a harness's global file a symlink
 * is as likely the operator's own way of keeping that file elsewhere.
 *
 * Nothing to deliver — no `instructions/` directory, or neither file for this agent — takes a link
 * of ours back. So the feature is off until the directory exists, and deleting it turns it off.
 */

/** The directory under the config directory that holds the instructions. */
export const INSTRUCTIONS_DIR = 'instructions';

/**
 * The most a composed file may be. Codex reads at most 32 KiB of an AGENTS.md by default
 * (`project_doc_max_bytes = 32768`, in its default config) and cuts the rest without a word; and this
 * text rides in every session of every agent, so a file anywhere near that is a mistake to report,
 * not one to deliver in part.
 */
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;

/** Where one harness reads its user-level instructions. */
export interface InstructionsHome {
  /** The per-agent file's name on the gateway, and the copy's on the host: `<name>.md`. */
  name: string;
  /** The harness's own user-level instruction file — where the link goes. */
  file: string;
  /** The harness's config directory: nothing is placed unless it exists. */
  requires: string;
}

/** Where `harness` reads its user-level instruction file under `home` (see the header). */
export function instructionsHome(harness: AgentDef['harness'], home: string, command?: string): InstructionsHome | undefined {
  switch (harness) {
    case 'claude':
      return { name: 'claude', file: path.join(home, '.claude', 'CLAUDE.md'), requires: path.join(home, '.claude') };
    case 'codex':
      return { name: 'codex', file: path.join(home, '.codex', 'AGENTS.md'), requires: path.join(home, '.codex') };
    case 'opencode':
      return {
        name: 'opencode',
        file: path.join(home, '.config', 'opencode', 'AGENTS.md'),
        requires: path.join(home, '.config', 'opencode'),
      };
    case 'agy':
      return {
        name: 'agy',
        file: path.join(home, '.gemini', 'config', 'AGENTS.md'),
        requires: path.join(home, '.gemini', 'antigravity-cli'),
      };
    case 'gemini':
    case 'dsh':
      return undefined;
    case 'custom': {
      const cmd = path.basename(command ?? '');
      if (cmd === 'codebuddy') {
        return { name: 'codebuddy', file: path.join(home, '.codebuddy', 'CODEBUDDY.md'), requires: path.join(home, '.codebuddy') };
      }
      if (cmd === 'atomcode') {
        return { name: 'atomcode', file: path.join(home, '.atomcode', 'ATOMCODE.md'), requires: path.join(home, '.atomcode') };
      }
      return undefined;
    }
    default: {
      const _exhaustive: never = harness;
      return _exhaustive;
    }
  }
}

/** The gateway's directory of instructions. */
export function instructionsDir(): string {
  return path.join(configDir(), INSTRUCTIONS_DIR);
}

/** The directory the copies live in on a host, which is also what makes a link "ours". */
export function ownedDir(home: string): string {
  return path.join(home, '.talkcode', INSTRUCTIONS_DIR);
}

/** What there is to deliver to one kind of agent. */
export type Composed = { kind: 'text'; text: string } | { kind: 'none' } | { kind: 'too-big'; bytes: number };

/**
 * `common.md`, then `<name>.md`, from `dir`, each trimmed and joined by a blank line. A missing file
 * is an empty layer; any other read error is thrown — an unreadable file must not read as "nothing
 * to deliver", which would take the link back.
 */
export function composeInstructions(dir: string, name: string): Composed {
  const parts: string[] = [];
  for (const file of ['common.md', `${name}.md`]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    if (text.trim()) parts.push(text.trim());
  }
  if (parts.length === 0) return { kind: 'none' };
  const text = `${parts.join('\n\n')}\n`;
  const bytes = Buffer.byteLength(text);
  return bytes > INSTRUCTIONS_MAX_BYTES ? { kind: 'too-big', bytes } : { kind: 'text', text };
}

/**
 * `common.md` alone — what every agent is told — for the automatic review, which must not suggest
 * a preference the person has already written there. Undefined when there is none; any read error
 * other than a missing file is thrown, for the caller to log.
 */
export function commonInstructions(dir: string = instructionsDir()): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'common.md'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, INSTRUCTIONS_MAX_BYTES) : undefined;
}

export type InstructionsOutcome =
  | 'linked'
  | 'relinked'
  | 'current'
  | 'occupied'
  | 'skipped'
  | 'failed'
  | 'removed'
  | 'absent'
  | 'kept'
  | 'too-big';

export interface InstructionsResult {
  link: string;
  outcome: InstructionsOutcome;
  /** What was there before, what is in the way, or the error. */
  detail?: string;
}

/** Outcomes after which the same text needs nothing more on that host until it changes. */
export const SETTLED: ReadonlySet<string> = new Set(['linked', 'relinked', 'current', 'removed', 'absent', 'kept', 'too-big']);

function isUnder(dest: string, dir: string): boolean {
  return path.resolve(dest).startsWith(path.resolve(dir) + path.sep);
}

/** Replace `file` with `text` in one rename, read-only — unless it already says exactly that. */
function writeCopy(file: string, text: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch {
    // not there yet, or unreadable: write it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  // A temporary left by a run that died between the two steps is read-only too: clear it first.
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { mode: 0o444 });
  fs.renameSync(tmp, file);
}

function linkCopy(copy: string, link: string, owned: string): InstructionsResult {
  let previous: string | undefined;
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return { link, outcome: 'occupied', detail: st.isDirectory() ? 'a directory' : 'a file' };
    previous = fs.readlinkSync(link);
    const dest = path.resolve(path.dirname(link), previous);
    if (dest === copy) return { link, outcome: 'current' };
    if (!isUnder(dest, owned)) return { link, outcome: 'occupied', detail: `a link to ${previous}` };
    fs.unlinkSync(link);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(copy, link, 'file');
  return previous === undefined ? { link, outcome: 'linked' } : { link, outcome: 'relinked', detail: previous };
}

function unlinkOwned(link: string, owned: string): InstructionsResult {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(link);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { link, outcome: 'absent' };
    throw e;
  }
  if (!st.isSymbolicLink()) return { link, outcome: 'kept', detail: 'not a link' };
  const previous = fs.readlinkSync(link);
  if (!isUnder(path.resolve(path.dirname(link), previous), owned)) return { link, outcome: 'kept', detail: `a link to ${previous}` };
  fs.unlinkSync(link);
  return { link, outcome: 'removed', detail: previous };
}

/** Deliver `composed` for one harness under `home` on this machine. No guard — the tests drive this directly. */
export function applyInstructions(composed: Composed, where: InstructionsHome, home: string): InstructionsResult {
  const link = where.file;
  const owned = ownedDir(home);
  try {
    if (composed.kind === 'none') return unlinkOwned(link, owned);
    if (composed.kind === 'too-big') {
      return { link, outcome: 'too-big', detail: `${composed.bytes} bytes, over the ${INSTRUCTIONS_MAX_BYTES}-byte limit` };
    }
    if (!fs.existsSync(where.requires)) return { link, outcome: 'skipped', detail: `${where.requires} does not exist` };
    const copy = path.join(owned, `${where.name}.md`);
    writeCopy(copy, composed.text);
    return linkCopy(copy, link, owned);
  } catch (e) {
    return { link, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Problems already reported, so a spawn-time call does not repeat the warning. */
const warned = new Set<string>();

/**
 * Say what one placement came to: a change once, a problem once per link and kind of problem, and
 * the quiet outcomes (unchanged, nothing there, nothing to do) not at all. `where` names the host
 * for an agent on another machine.
 */
export function reportInstructions(r: InstructionsResult, where = ''): void {
  const at = where ? `${where}: ` : '';
  if (r.outcome === 'linked') console.log(`[instructions] ${at}linked ${r.link}`);
  else if (r.outcome === 'relinked') console.log(`[instructions] ${at}repointed ${r.link} (was ${r.detail})`);
  else if (r.outcome === 'removed') console.log(`[instructions] ${at}took back ${r.link}: nothing to deliver to it`);
  else if (r.outcome === 'occupied' || r.outcome === 'failed' || r.outcome === 'too-big') {
    const key = `${at}${r.link}:${r.outcome}:${r.detail ?? ''}`;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(
      r.outcome === 'occupied'
        ? `[instructions] ${at}${r.link} is ${r.detail} — leaving it alone, so this agent does not get the instructions`
        : r.outcome === 'too-big'
          ? `[instructions] ${at}not delivered to ${r.link}: ${r.detail}`
          : `[instructions] ${at}could not place ${r.link}: ${r.detail}`
    );
  }
}

/**
 * Deliver the instructions for one local agent's harness under `home`. Best-effort: every outcome
 * is logged or silent, never thrown — an agent without them still works. Guarded like the skill
 * link (skill-link.ts), for the same reason: it writes to the operator's own directories, so a test
 * worker must never reach it, and TALKCODE_NO_SKILL_LINK=1 keeps a test daemon off the live files.
 */
export function placeInstructions(def: AgentDef, home: string): InstructionsResult | undefined {
  if (process.env.TALKCODE_NO_SKILL_LINK) return undefined;
  if (!selfInvocation()) return undefined;
  const where = instructionsHome(def.harness, home, def.command);
  if (!where) return undefined;
  let composed: Composed;
  try {
    composed = composeInstructions(instructionsDir(), where.name);
  } catch (e) {
    const r: InstructionsResult = { link: where.file, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) };
    reportInstructions(r);
    return r;
  }
  const r = applyInstructions(composed, where, home);
  reportInstructions(r);
  return r;
}
