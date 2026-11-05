import fs from 'node:fs';
import path from 'node:path';
import { configPath, readRawConfigIfExists, saveConfigPatch } from '../config/load.js';

/**
 * Giving agents new ids without losing their conversations: `<config dir>/agent-renames.json`, a
 * map `{ "<old id>": "<new id>" }`, applied once when the daemon starts and then set aside as
 * `agent-renames.json.applied-<time>`.
 *
 * An id is not only a name in config.yaml. Every conversation is bound to one and keeps each agent's
 * session under it (conversations.json), and a scheduled task names the agent it runs
 * (schedules.json). Changing the id in config.yaml alone leaves all of those pointing at an agent
 * that no longer exists: each topic falls back to the default agent and starts a new session. So
 * the three files change together, and only at startup — a running daemon holds the stores in
 * memory and writes them back. The three are copied to `*.bak-renames-<time>` first.
 *
 * Written for moving to pod-declared agents (`oc2` → `oc@awsfree2`, see daemon/pods.ts), and just as
 * good for any other rename.
 */

export const RENAMES_FILE = 'agent-renames.json';

/** The map in the file, or undefined: no file, or one that is wrong (said in the log, left in place). */
export function readAgentRenames(dir: string): Map<string, string> | undefined {
  const file = path.join(dir, RENAMES_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[renames] ${file} is not JSON; nothing renamed: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
  const problem = checkRenames(raw);
  if (problem) {
    console.error(`[renames] ${file}: ${problem}; nothing renamed`);
    return undefined;
  }
  return new Map(Object.entries(raw as Record<string, string>));
}

/** Why a map cannot be applied, or undefined when it can. */
export function checkRenames(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'expected an object of "old id": "new id"';
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return 'it is empty';
  const bad = entries.find(([from, to]) => typeof to !== 'string' || to.trim() === '' || to === from);
  if (bad) return `"${bad[0]}" must map to a different, non-empty id`;
  const targets = entries.map(([, to]) => to as string);
  const twice = targets.find((t, i) => targets.indexOf(t) !== i);
  if (twice) return `two agents would both become "${twice}"`;
  // A → B and B → C applied at once would depend on the order; say it rather than pick one.
  const chained = targets.find((t) => Object.prototype.hasOwnProperty.call(raw, t));
  if (chained) return `"${chained}" is both renamed and a new name; rename in two steps`;
  return undefined;
}

/** Rename in config.yaml: `agents[].id`, `routing.default`, `routing.pipeline[].use.agent`, `review.agent`. Comments are kept. */
export function renameAgentsInConfig(renames: ReadonlyMap<string, string>): number {
  const raw = readRawConfigIfExists();
  if (!raw) return 0;
  const patch: Array<{ path: Array<string | number>; value: unknown }> = [];
  const agents = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
  agents.forEach((a, i) => {
    const to = renames.get(idOf(a));
    if (to) patch.push({ path: ['agents', i, 'id'], value: to });
  });
  const routing = raw.routing && typeof raw.routing === 'object' ? (raw.routing as Record<string, unknown>) : {};
  const def = typeof routing.default === 'string' ? renames.get(routing.default) : undefined;
  if (def) patch.push({ path: ['routing', 'default'], value: def });
  const pipeline = Array.isArray(routing.pipeline) ? (routing.pipeline as unknown[]) : [];
  pipeline.forEach((rule, i) => {
    const use = rule && typeof rule === 'object' ? (rule as { use?: unknown }).use : undefined;
    const to = renames.get(idOf(use, 'agent'));
    if (to) patch.push({ path: ['routing', 'pipeline', i, 'use', 'agent'], value: to });
  });
  // The reviewer is an agent reference too: left on the old id, `review.agent` names an agent the
  // renamed config no longer has and the gateway refuses to start. Only the id moves; the model
  // (which belongs to the review, not the agent) stays.
  const review = raw.review && typeof raw.review === 'object' ? (raw.review as Record<string, unknown>) : {};
  const reviewer = typeof review.agent === 'string' ? renames.get(review.agent) : undefined;
  if (reviewer) patch.push({ path: ['review', 'agent'], value: reviewer });
  if (patch.length) saveConfigPatch(patch);
  return patch.length;
}

/** Copy the files a rename changes, before it changes them. */
export function backUpForRenames(dir: string, stamp: string): void {
  for (const file of [configPath(), path.join(dir, 'conversations.json'), path.join(dir, 'schedules.json')]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-renames-${stamp}`);
  }
}

/** Set the file aside, so the next start does not apply it again. */
export function setRenamesAside(dir: string, stamp: string): void {
  const file = path.join(dir, RENAMES_FILE);
  fs.renameSync(file, `${file}.applied-${stamp}`);
}

function idOf(v: unknown, key = 'id'): string {
  const id = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  return typeof id === 'string' ? id : '';
}
