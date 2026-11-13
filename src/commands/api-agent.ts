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
 *   - id: muse
 *     harness: custom
 *     command: fleetherd
 *     args: [api-agent, mailbox, --url, "https://mailbox.example.com"]
 *     env: { MAILBOX_TOKEN: "${MUSE_MAILBOX_TOKEN}" }
 *
 * Failures before the protocol starts go to stderr and exit non-zero, never stdout: the daemon
 * parses stdout as JSON-RPC, so a human-readable line there would be a protocol error instead of
 * the reason. Flags are read here, once, and baked into the backend.
 */
import path from 'node:path';
import { configDir } from '../config/load.js';
import { ANTIGRAVITY_MODELS, createAntigravityBackend } from '../api-agent/antigravity.js';
import type { ApiBackend, ModelOption } from '../api-agent/backend.js';
import { createMailboxBackend, PICKUP_TIMEOUT_MS, SILENCE_TIMEOUT_MS } from '../api-agent/mailbox.js';
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

/**
 * The gateway's silence watchdog, `session.turnTimeoutMs` (frozen at 600 s, config/schema.ts).
 * The mailbox's own silence limit must end a turn before it fires: past it the gateway kills the
 * child and reports a hang, where the mailbox would have ended the turn with what had arrived.
 */
const GATEWAY_TURN_TIMEOUT_S = 600;

export interface ApiAgentCliOptions {
  /** Comma-separated model ids; default: every model the backend knows. */
  models?: string;
  /** Per-turn `max_total_tokens`. */
  maxTokens?: string;
  /** mailbox: the relay's base URL (else MAILBOX_URL). */
  url?: string;
  /** mailbox: seconds a message may wait to be picked up. */
  pickupTimeout?: string;
  /** mailbox: seconds a running turn may go without a reply. */
  silenceTimeout?: string;
}

export async function runApiAgent(backendId: string, options: ApiAgentCliOptions): Promise<void> {
  if (backendId === 'mailbox') return runMailbox(options);
  const known = backendId === 'antigravity' ? ANTIGRAVITY_MODELS : undefined;
  if (!known) {
    // stderr, not the CLI's usual TOON-on-stdout: stdout is the ACP transport here.
    console.error(`[api-agent] unknown backend "${backendId}"; known backends: antigravity, mailbox`);
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
  await serve(backend);
}

/**
 * `api-agent mailbox`: a turn is a message left in an agent-mailbox relay (api-agent/mailbox.ts).
 * One agent entry per mailbox, i.e. per agent account; several accounts are several entries.
 */
async function runMailbox(options: ApiAgentCliOptions): Promise<void> {
  let backend: ApiBackend;
  try {
    if (options.models !== undefined || options.maxTokens !== undefined) {
      throw new Error('--models and --max-tokens do not apply to the mailbox backend');
    }
    const url = parseRelayUrl(options.url ?? process.env.MAILBOX_URL);
    const pickupTimeoutMs = parseSeconds(options.pickupTimeout, PICKUP_TIMEOUT_MS, '--pickup-timeout');
    const silenceTimeoutMs = parseSeconds(options.silenceTimeout, SILENCE_TIMEOUT_MS, '--silence-timeout');
    if (silenceTimeoutMs >= GATEWAY_TURN_TIMEOUT_S * 1000) {
      throw new Error(`--silence-timeout must be under the gateway's ${GATEWAY_TURN_TIMEOUT_S}s turn timeout`);
    }
    backend = createMailboxBackend({
      url,
      // Only from the environment, like GEMINI_API_KEY: an argument is visible in `ps` and is
      // written into config.yaml as it is, where `${VAR}` in env keeps the secret out of it.
      token: process.env.MAILBOX_TOKEN ?? '',
      pickupTimeoutMs,
      silenceTimeoutMs,
    });
  } catch (err) {
    console.error(`[api-agent] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  await serve(backend);
}

async function serve(backend: ApiBackend): Promise<void> {
  const store = new SessionStore({
    // The gateway's container mounts configDir and nothing else, so this is the only path that
    // survives `fleetherd update` (see the store's header). One file per session, so several
    // agents of this backend cannot overwrite each other's conversations.
    dir: path.join(configDir(), 'api-agent', backend.id),
  });
  await serveApiAgent({ backend, store, models: backend.models });
}

/** The relay's base URL: https, or http to this machine (a local test relay). */
export function parseRelayUrl(raw: string | undefined): string {
  if (!raw || !raw.trim()) throw new Error('no relay URL: pass --url or set MAILBOX_URL');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`relay URL "${raw}" is not a URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('the relay URL must be https (http only to localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('the relay URL takes no credentials, query or fragment; the token goes in MAILBOX_TOKEN');
  }
  return url.toString().replace(/\/+$/, '');
}

export function parseSeconds(spec: string | undefined, fallbackMs: number, flag: string): number {
  if (spec === undefined) return fallbackMs;
  const value = Number(spec);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} takes a positive number of seconds, got "${spec}"`);
  return Math.round(value * 1000);
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
