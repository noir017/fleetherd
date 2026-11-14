import fs from 'node:fs';
import path from 'node:path';
import type { AgentDef } from '../config/schema.js';
import { envOf } from '../legacy-name.js';
import { selfInvocation } from './reverse-cli-shim.js';
import { bundledSkillDir, linkSkill, type SkillHome, type SkillLinkResult } from './skill-link.js';

/**
 * The agy plugin the package ships (`agy-plugin/` at its root): one Stop hook that keeps an agy turn
 * open while a command it put in the background is still running, so what happens when it finishes
 * reaches the chat.
 *
 * ── What `agy acp` does with a background command ─────────────────────────────────────────────────
 * Measured on agy 1.5.8, 2026-11-14 (project-scripts/agy-bg-probe/ in the operator's workspace):
 *
 *   - `run_command` waits at most 10 s (`WaitMsBeforeAsync` is capped at 10000), so anything longer
 *     goes to the background, and the prompt ends as soon as the model has said so.
 *   - When the command finishes, agy writes a message to the conversation's mailbox and starts a
 *     turn of its own to read it. No prompt is open, so nothing of that turn is sent: no
 *     `session/update`, and its first `session/request_permission` — almost always the next
 *     `run_command` — is held until the person's next message. The turn does not just go unseen, it
 *     stops: a probe's `echo` waited 55 s for a second prompt; a scheduled run waited for ever.
 *   - The gateway cannot reach in: a `session/prompt` with no content is refused ("Empty prompt"),
 *     `session/set_config_option` releases nothing, and any content would be the gateway's own words
 *     in the agent's prompt (AGENTS.md).
 *
 * agy's terminal and print modes wait for background tasks before they finish; only ACP does not.
 * Its Stop hook is how to make it (`agy-customizations/docs/hooks.md`, bundled with agy): the hook
 * sees `fullyIdle: false` while a task runs, and `{"decision": "continue"}` sends the loop round
 * again instead of ending it. While the loop is held, the task's message is read inside it, so the
 * permission request, the tool updates and the reply all go out over the prompt that is still open.
 *
 * ── How the hook waits (wait-background.sh) ───────────────────────────────────────────────────────
 * Silently. It returns `continue` with no `reason` — a reason is text the model reads — and only
 * when the mailbox has something new: a task finishing, or a message the person sent mid-turn
 * (agy-acp.ts takesPromptMidTurn). The model is not called while it waits. A 2026-11-12 attempt
 * re-prompted every 20 s with instructions to check the task; agy allows a turn ten forced
 * continuations (measured: the eleventh is ignored and the turn ends), so that gave up after about
 * three and a half minutes, and the model, reading why, polled with `sleep 9.2` instead.
 *
 * It also lets the model go once it has waited AGY_WAIT_WINDOW_S with nothing new, so that the
 * gateway's silence watchdog never takes a quiet wait for a hang: a turn with a tool call open —
 * the background command stays open until it finishes — may be quiet for turnTimeoutMs ×
 * (1 + TOOL_SILENCE_FACTOR), and the model's turn after the window starts the count again. That
 * costs one model turn per window (in a probe, a task listing and a line saying it is still
 * running), and one of the ten continuations. agy-plugin.test.ts holds the window under the ceiling
 * and hooks.json's timeout above the window: agy ends the turn on a hook that times out and never
 * stops the hook, so the hook ends itself — at the window, or when agy is gone.
 *
 * ⚠️ HYRUM'S LAW: the mailbox — `brain/<conversation>/.system_generated/messages/<id>.json`, a
 * `priority` field, and `read.json` listing what agy has read — is agy's private layout, not an
 * interface. If it changes, the hook finds nothing new and lets the model go once a window; the
 * task's result still arrives in the turn, a window late at most. agy-plugin.test.ts drives the
 * script against that layout as captured.
 *
 * ── Why a plugin, linked like the skills ──────────────────────────────────────────────────────────
 * agy merges every plugin's `hooks.json` with the operator's own (`~/.gemini/config/hooks.json`), so
 * the gateway adds its hook without editing a file that is the operator's. Plugins are found under
 * `<customization root>/plugins/<name>/`; `~/.gemini/config/plugins/fleetherd` as a symlink was
 * loaded (agy 1.5.8, isolated HOME, project-scripts/fleetherd-agy-bg-wait/). Linked from the package
 * like the bundled skills (skill-link.ts), so an upgrade updates it, under the same rules: only where
 * agy has run, a link of ours repointed, anything else left alone. The hook acts only with
 * FLEETHERD_TURN_TOKEN set — a conversation this gateway runs; an agy the operator runs by hand
 * already waits for its tasks.
 */

/** The name the plugin is linked under, and the directory it ships in at the package root. */
export const AGY_PLUGIN_NAME = 'fleetherd';
export const AGY_PLUGIN_DIR = 'agy-plugin';

/**
 * How long the hook waits with nothing new before letting the model go (wait-background.sh's
 * default, read from the script by the test that holds it under the watchdog's ceiling).
 */
export const AGY_WAIT_WINDOW_S = 1200;

/** The plugin's directory in this package. */
export function agyPluginSource(): string {
  return bundledSkillDir(AGY_PLUGIN_DIR);
}

/** Where agy looks for plugins under `home`, for an agy agent; undefined for every other harness. */
export function agyPluginHome(harness: AgentDef['harness'], home: string): SkillHome | undefined {
  if (harness !== 'agy') return undefined;
  return { dir: path.join(home, '.gemini', 'config', 'plugins'), requires: path.join(home, '.gemini', 'antigravity-cli') };
}

/** Links already reported as occupied or failed, so a spawn does not repeat the warning. */
const warned = new Set<string>();

/**
 * Link the plugin for an agy agent under `home`, at every spawn. Best-effort, like the skills: an
 * agy without it still runs, as it did before — its background results just do not come back.
 */
export function ensureAgyPlugin(harness: AgentDef['harness'], home: string): SkillLinkResult | undefined {
  const where = agyPluginHome(harness, home);
  if (!where || envOf('NO_SKILL_LINK') || !selfInvocation()) return undefined;
  const source = agyPluginSource();
  if (!fs.existsSync(path.join(source, 'hooks.json'))) {
    if (!warned.has(source)) console.warn(`[agy] no plugin at ${source}; agy's background results will not reach the chat`);
    warned.add(source);
    return undefined;
  }
  const r = linkSkill(source, where, AGY_PLUGIN_NAME);
  if (r.outcome === 'linked') console.log(`[agy] linked ${r.link} → ${source}`);
  else if (r.outcome === 'relinked') console.log(`[agy] repointed ${r.link} → ${source} (was ${r.detail})`);
  else if ((r.outcome === 'occupied' || r.outcome === 'failed') && !warned.has(r.link)) {
    warned.add(r.link);
    console.warn(`[agy] could not link the plugin at ${r.link} (${r.outcome}: ${r.detail ?? ''}); background results will not reach the chat`);
  }
  return r;
}
