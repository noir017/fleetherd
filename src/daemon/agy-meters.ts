import type { QuotaPool } from '../types.js';

/**
 * What agy tells the footer about a session — context window, quota — where ACP does not.
 *
 * `agy acp` reports usage once per turn (the prompt response, summed over the turn's model calls —
 * see agent-acp.ts settleAgyTurn) but never says how big the window is, has no quota method, and
 * answers a `/usage` prompt as a question about usage. So the window is a table of the ones
 * measured, and the quota is a one-shot `agy -p=/usage` (agy-cli.ts, driven by agy-acp.ts
 * createAgyQuotaMeter).
 */

/**
 * Context window sizes, by model. agy reports none — not in ACP, not in `agy models`, not in its
 * hooks — so the only way to know one is to have seen agy's own status line draw it.
 *
 * Every entry was read off that status line under a PTY, where agy 1.4.7 still runs it, with no
 * prompt sent (2026-10-27, `project-scripts/talkcode-agy-147-usage/window.py`). It draws the window
 * to one decimal of a thousand, so the Claude and GPT-OSS figures are exact to within that:
 *
 *   Gemini 3.8 Flash (High)        → 1.0M     (1048576 exactly, from the raw snapshot on 1.2.0)
 *   Claude Sonnet / Opus 4.6       → 250.0k
 *   GPT-OSS 120B (Medium)          → 131.1k   (131072, the power of two that rounds there)
 *
 * Matched on either spelling, because agy names a model by id in `init` and by display name on
 * its default. A model in neither row gets no window and therefore no context numbers: a guessed
 * denominator would draw a confident percentage out of nothing, and the next model Google adds is
 * exactly the one nobody has measured.
 *
 * This is the model's window, not where agy compacts — and the footer is about compaction. It is
 * used only for a model whose window was measured but whose compaction point was not; a model in
 * neither table gets nothing.
 */
const CONTEXT_WINDOWS: ReadonlyArray<{ match: RegExp; size: number }> = [
  { match: /^gemini[ -]3\.8[ -]flash/i, size: 1_048_576 },
  { match: /^claude-(sonnet|opus)-4-6|^claude (sonnet|opus) 4\.6\b/i, size: 250_000 },
  { match: /^gpt-oss[- ]120b/i, size: 131_072 },
];

/** The window for a model, in either spelling; undefined for one nobody has measured. */
export function agyContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return CONTEXT_WINDOWS.find((w) => w.match.test(model.trim()))?.size;
}

/**
 * Where agy compacts, by model — the `max_token_limit` Google hands it in its model list
 * (`modelExperiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER`, read on 1.5.2, 2026-11-07; see
 * agy-relay.ts). The window above is what the model can hold; this is the budget agy actually
 * stops at, and it is the footer's denominator:
 *
 *   Gemini 3.8 Flash               → 256k, on a 1M window
 *   Claude Sonnet / Opus 4.6       → 160k
 *   GPT-OSS 120B                   → 80k
 *
 * Without a `contextBudget` these are the numbers the footer has to show. The window table said
 * 1M for Gemini 3.8 Flash, so a session at 236k — 92% of the way to agy compacting — read as
 * `236k / 1M (23%)`, and the compaction arrived as a surprise (2026-11-13).
 *
 * Only the models measured are listed. A Gemini newer than 3.8, or any model Google adds later,
 * gets no number rather than a guessed one — the same rule as the window table.
 */
const COMPACTION_POINTS: ReadonlyArray<{ match: RegExp; size: number }> = [
  { match: /^gemini[ -]3\.8[ -]flash/i, size: 256_000 },
  { match: /^claude-(sonnet|opus)-4-6|^claude (sonnet|opus) 4\.6\b/i, size: 160_000 },
  { match: /^gpt-oss[- ]120b/i, size: 80_000 },
];

/** Where agy compacts for a model, in either spelling; undefined for one nobody has measured. */
export function agyCompactionPoint(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return COMPACTION_POINTS.find((w) => w.match.test(model.trim()))?.size;
}

/**
 * `agy -p=/usage`, as the pools the status line used to report. Verbatim on 1.4.7 (2026-10-27):
 *
 *   Gemini Models          Weekly Limit Remaining     74%   2026-10-31T04:24:11Z
 *   Gemini Models          Five Hour Limit Remaining  86%   2026-10-27T06:49:21Z
 *   Claude and GPT models  Weekly Limit Remaining     100%  2026-11-03T06:27:38Z
 *   Claude and GPT models  Five Hour Limit Remaining  100%  2026-10-27T11:27:38Z
 *
 * (tab-separated). The rows are renamed to the ids the status line used — `gemini-weekly`,
 * `3p-5h`, … — because the web UI's labels and markActivePools both key on that shape, and a pool
 * is the same pool whichever channel reported it. Sorted by id, which is also the order the status
 * line sent them in. A row whose family or window is not one of these is dropped and logged, not
 * renamed by guess: an unknown pool shown under a made-up id would be worse than one not shown.
 *
 * Coarser than the status line was — whole percentages, where it sent `0.7486224` — because that is
 * all this command prints.
 */
export function parseAgyUsagePools(output: string): QuotaPool[] | undefined {
  const pools: QuotaPool[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [family = '', metric = '', remaining = '', reset = ''] = line.split('\t').map((c) => c.trim());
    const fam = poolFamily(family);
    const win = poolWindow(metric);
    const pct = Number.parseFloat(remaining);
    if (!fam || !win || !Number.isFinite(pct)) {
      console.debug('[agy] /usage row not understood, left out of the quota:', line.slice(0, 120));
      continue;
    }
    const pool: QuotaPool = { id: `${fam}-${win}`, remaining: Math.min(1, Math.max(0, pct / 100)) };
    const at = Date.parse(reset);
    if (Number.isFinite(at)) pool.resetsAt = at;
    pools.push(pool);
  }
  pools.sort((a, b) => a.id.localeCompare(b.id));
  return pools.length ? pools : undefined;
}

/** `Gemini Models` → gemini, `Claude and GPT models` → 3p: the status line's family names. */
function poolFamily(name: string): string | undefined {
  if (/gemini/i.test(name)) return 'gemini';
  if (/claude|gpt/i.test(name)) return '3p';
  return undefined;
}

/** `Weekly Limit Remaining` → weekly, `Five Hour Limit Remaining` → 5h. */
function poolWindow(metric: string): string | undefined {
  if (/week/i.test(metric)) return 'weekly';
  if (/five hour|\b5 ?h/i.test(metric)) return '5h';
  if (/day/i.test(metric)) return 'daily';
  return undefined;
}

/** The model families agy's third-party pool serves. */
const THIRD_PARTY_MODEL = /claude|gpt|sonnet|haiku|opus|o1|o3|3p/i;

/**
 * Mark the pools the serving model spends from.
 *
 * agy meters Gemini and third-party models (Claude, GPT) separately, and names its pools after
 * which: `gemini-*` and `3p-*`. A pool of neither family, or a turn with no known model, is left
 * unmarked — the page then shows every pool alike rather than highlighting a guess.
 */
export function markActivePools(pools: QuotaPool[], model: string | undefined): QuotaPool[] {
  if (!model) return pools;
  const thirdParty = THIRD_PARTY_MODEL.test(model);
  return pools.map((p) => {
    const family = p.id.split('-')[0]?.toLowerCase();
    if (family === '3p' || family === 'claude') return { ...p, active: thirdParty };
    if (family === 'gemini') return { ...p, active: !thirdParty };
    return p;
  });
}
