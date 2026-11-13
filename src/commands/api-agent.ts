/**
 * `fleetherd api-agent <backend>` — the process `harness: custom` spawns.
 *
 * It is not meant to be run by hand: with no ACP client on stdin it simply waits, and its stdout
 * is the protocol stream. config.yaml names it:
 *
 *   - id: agapi
 *     harness: custom
 *     command: fleetherd
 *     args: [api-agent, antigravity]
 *     env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" }
 *
 * Failures before the protocol starts go to stderr and exit non-zero, never stdout: the daemon
 * parses stdout as JSON-RPC, so a human-readable line there would be a protocol error instead of
 * the reason. `--models` and `--max-tokens` are read here, once, and baked into the backend.
 */
import path from 'node:path';
import { configDir } from '../config/load.js';
import { ANTIGRAVITY_MODELS, createAntigravityBackend } from '../api-agent/antigravity.js';
import type { ModelOption } from '../api-agent/backend.js';
import { serveApiAgent } from '../api-agent/server.js';
import { SessionStore } from '../api-agent/store.js';

/**
 * Default per-turn token budget.
 *
 * A turn is a whole agent loop: every step re-sends the conversation, and the recorded harness
 * spends ~5.3k input tokens before it says anything — a trivial one-command turn used 11k
 * (probe, 2026-11-13). The probe's 20k cap is therefore a test setting, not a working one: it
 * would cut ordinary multi-step work short. 200k leaves room for that work while bounding a
 * runaway loop to a fifth of the model's 1M window. The API treats the number as best-effort
 * (it may overshoot between steps) and answers `status: "incomplete"` when it is reached.
 */
export const DEFAULT_MAX_TOKENS = 200_000;

export interface ApiAgentCliOptions {
  /** Comma-separated model ids; default: every model the backend knows. */
  models?: string;
  /** Per-turn `max_total_tokens`. */
  maxTokens?: string;
}

export async function runApiAgent(backendId: string, options: ApiAgentCliOptions): Promise<void> {
  const known = backendId === 'antigravity' ? ANTIGRAVITY_MODELS : undefined;
  if (!known) {
    // stderr, not the CLI's usual TOON-on-stdout: stdout is the ACP transport here.
    console.error(`[api-agent] unknown backend "${backendId}"; known backends: antigravity`);
    process.exitCode = 1;
    return;
  }

  let models: ModelOption[];
  let maxTokens: number;
  try {
    models = resolveModels(options.models, known);
    maxTokens = parseMaxTokens(options.maxTokens);
  } catch (err) {
    console.error(`[api-agent] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const backend = createAntigravityBackend({
    // Only ever from the environment. config.yaml expands `${GEMINI_API_KEY}` into the agent's
    // env; a key written into this repository or into args would be a secret on disk and in `ps`.
    apiKey: process.env.GEMINI_API_KEY ?? '',
    models,
    maxTokens,
  });
  const store = new SessionStore({
    // The gateway's container mounts configDir and nothing else, so this is the only path that
    // survives `fleetherd update` (see the store's header). One file per session, so several
    // agents of this backend cannot overwrite each other's conversations.
    dir: path.join(configDir(), 'api-agent', backend.id),
  });

  await serveApiAgent({ backend, store, models: backend.models });
}

/** `--models a,b`: narrow the menu, keeping display names for the ids we know. */
export function resolveModels(spec: string | undefined, known: readonly ModelOption[]): ModelOption[] {
  if (!spec || !spec.trim()) return [...known];
  const values = spec
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error('--models needs at least one model id');
  // An id the build does not know is still offered: model lists change faster than releases,
  // and the API's own error is clearer than a refusal invented here.
  return values.map((value) => known.find((model) => model.value === value) ?? { value, name: value });
}

export function parseMaxTokens(spec: string | undefined): number {
  if (spec === undefined) return DEFAULT_MAX_TOKENS;
  const value = Number(spec);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--max-tokens must be a positive integer, got "${spec}"`);
  }
  return value;
}
