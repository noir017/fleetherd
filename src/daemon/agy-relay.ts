import { createHash } from 'node:crypto';
import type { AgentDef } from '../config/schema.js';
import { expandEnv } from './agent-common.js';
import type { HarnessRelay } from './relay.js';

/**
 * agy behind a relay (relay.ts), to give it the compaction budget the operator chose
 * (`agents[].contextBudget`) instead of the one Google hands it.
 *
 * Measured on agy 1.5.2 (2026-11-07, `project-scripts/talkcode-agy-intercept/`, isolated HOME):
 *
 *   - **The budget is Google's, per model.** `POST /v1internal:fetchAvailableModels` answers every
 *     model with `modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue` — a
 *     JSON document inside a string — whose `max_token_limit` is where agy compacts: 256000 for
 *     Gemini 3.8 Flash (a 1,048,576 window), 160000 for Claude 4.6, 128000 for older Gemini, 80000 for
 *     GPT-OSS. It wins over everything on the machine: `AGY_CLI_AUTO_COMPACT_OVERRIDE`, a
 *     `contextWindow` setting and a binary with its own clamp patched out all still compacted at 256k.
 *   - **Every Cloud Code request follows `CLOUD_CODE_URL`** (agy logs "Overriding CloudCodeServerURL
 *     via CLOUD_CODE_URL"), plain http to loopback included: the model list, experiments, quota and the
 *     streamed model calls. Without the variable agy talks to AGY_DEFAULT_UPSTREAM.
 *   - **Rewriting the value takes.** With 900000 served, the conversation's own record of each model
 *     call (`gen_metadata`, field 1.9.10.4) reads 900000 where it read 256000; and the operator
 *     confirmed a Gemini 3.8 Flash context of at least 600k tokens works with the budget raised.
 *
 * ⚠️ HYRUM'S LAW: the path, the field names and the string-in-JSON are Google's, undocumented, and
 * can change with any agy or server release. A response without them is served as it came — agy then
 * compacts where Google says, as it would with no relay — and the first such miss is logged.
 * agy-relay.test.ts replays a trimmed capture of the real response.
 */

/** Where agy 1.5.2 sends Cloud Code requests when CLOUD_CODE_URL is unset (its logs, 2026-11-07). */
export const AGY_DEFAULT_UPSTREAM = 'https://daily-cloudcode-pa.googleapis.com';
const MODELS_PATH = '/v1internal:fetchAvailableModels';
const CHECKPOINTER = 'CASCADE_USE_EXPERIMENT_CHECKPOINTER';
const LIMIT = /("max_token_limit"\s*:\s*")(\d+)(")/;

interface AgyModel {
  displayName?: unknown;
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  modelExperiments?: { experiments?: Record<string, { stringValue?: unknown } | undefined> };
}

/**
 * Set `budget` as every model's compaction point where the model can hold it — its window less its
 * own output reserve — and leave the rest at Google's. Lowering is allowed too (an earlier compaction
 * spends less quota). Mutates `json`; answers how many models changed and the budget each model
 * ends up with, by id and by display name (lower-cased), or undefined when `json` is not the shape
 * above.
 */
export function applyAgyBudget(json: unknown, budget: number): { changed: number; budgets: Map<string, number> } | undefined {
  const models = (json as { models?: unknown } | null)?.models;
  if (!models || typeof models !== 'object') return undefined;
  const budgets = new Map<string, number>();
  let changed = 0;
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    const m = raw as AgyModel | null;
    const exp = m?.modelExperiments?.experiments?.[CHECKPOINTER];
    if (!m || typeof exp?.stringValue !== 'string') continue;
    const found = LIMIT.exec(exp.stringValue);
    if (!found) continue;
    let limit = Number(found[2]);
    const window = Number(m.maxTokens ?? 0);
    const reserve = Number(m.maxOutputTokens ?? 0);
    if (window > 0 && budget + reserve <= window && budget !== limit) {
      exp.stringValue = exp.stringValue.replace(LIMIT, `$1${budget}$3`);
      limit = budget;
      changed += 1;
    }
    budgets.set(id.toLowerCase(), limit);
    if (typeof m.displayName === 'string') budgets.set(m.displayName.toLowerCase(), limit);
  }
  return { changed, budgets };
}

/** What each relay last told agy, by relay id: the footer's denominator (agyBudget). */
const told = new Map<string, Map<string, number>>();
const missed = new Set<string>();

function transformModels(id: string, budget: number, body: Buffer): Buffer | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    json = undefined;
  }
  const result = json === undefined ? undefined : applyAgyBudget(json, budget);
  if (!result || result.budgets.size === 0) {
    if (!missed.has(id)) {
      missed.add(id);
      console.warn(`[relay] ${id}: agy's model list no longer has the ${CHECKPOINTER} budgets it had on 1.5.2; served as it came, so agy compacts where Google says (see daemon/agy-relay.ts)`);
    }
    return undefined;
  }
  told.set(id, result.budgets);
  return result.changed > 0 ? Buffer.from(JSON.stringify(json), 'utf8') : undefined;
}

/** agy's relay, for an agent with a `contextBudget`. */
export function agyRelay(def: AgentDef): HarnessRelay | undefined {
  const budget = def.contextBudget;
  if (budget === undefined) return undefined;
  // An operator's own CLOUD_CODE_URL (a proxy of theirs, another endpoint) is chained to, not lost.
  const own = def.env['CLOUD_CODE_URL'];
  const upstream = own ? expandEnv(own) : AGY_DEFAULT_UPSTREAM;
  const id = `agy.${budget}.${createHash('sha256').update(upstream).digest('hex').slice(0, 8)}`;
  return {
    envVar: 'CLOUD_CODE_URL',
    spec: { id, upstream, paths: [MODELS_PATH], transform: (_path, body) => transformModels(id, budget, body) },
  };
}

/**
 * The compaction budget agy was last given for `model` through this agent's relay, or undefined
 * before it has fetched its model list (or without a relay). `agy acp` names a model without its
 * thinking level (`gemini-3.8-flash`) where the list has one per level (`gemini-3.8-flash-high`), so a
 * name the list does not have is matched to the first that extends it — the levels share a budget.
 */
export function agyBudget(def: AgentDef, model: string | undefined): number | undefined {
  const relay = agyRelay(def);
  const budgets = relay && told.get(relay.spec.id);
  if (!budgets || !model) return undefined;
  const key = model.trim().toLowerCase();
  const exact = budgets.get(key);
  if (exact !== undefined) return exact;
  for (const [name, b] of budgets) if (name.startsWith(`${key}-`)) return b;
  return undefined;
}
